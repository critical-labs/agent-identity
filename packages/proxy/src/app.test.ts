import type { AgentRecord, NoncesRepo } from "@agent-identity/api";
import {
  canonicalString, generateKeypair, sign,
  type CommitSpec, type PrSpec, type RepoRef,
} from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createProxyApp, type ProxyDeps } from "./app.js";
import type { Author, Forge } from "./forge.js";
import { ForgeError } from "./forge.js";

const kp = generateKeypair();

function signed(method: string, path: string, body = "") {
  const timestamp = new Date().toISOString();
  return {
    method,
    body: body || undefined,
    headers: {
      "x-agent-key": kp.publicKeySpkiBase64,
      "x-agent-timestamp": timestamp,
      "x-agent-signature": sign(canonicalString(method, path, timestamp, body), kp.privateKeyPem),
      ...(body ? { "content-type": "application/json" } : {}),
    },
  };
}

const agent: AgentRecord = {
  agentId: "482913", address: "482913@agents.example", publicKey: kp.publicKeySpkiBase64,
  status: "active", createdAt: "t", capabilities: ["github"],
};

const permissiveNonces: NoncesRepo = { recordOnce: async () => true } as never;

export class FakeForge implements Forge {
  calls: unknown[][] = [];
  failWith?: ForgeError;
  async getRepo(ref: RepoRef, actor: Author) {
    this.calls.push(["getRepo", ref, actor]);
    if (this.failWith) throw this.failWith;
    return { defaultBranch: "main", headSha: "abc123" };
  }
  async createCommit(ref: RepoRef, spec: CommitSpec, actor: Author) {
    this.calls.push(["createCommit", ref, spec, actor]);
    if (this.failWith) throw this.failWith;
    return { sha: "c1", url: "https://forge/c1" };
  }
  async openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author) {
    this.calls.push(["openPullRequest", ref, spec, actor]);
    if (this.failWith) throw this.failWith;
    return { number: 7, url: "https://forge/pr/7" };
  }
  async comment(ref: RepoRef, issue: number, body: string, actor: Author) {
    this.calls.push(["comment", ref, issue, body, actor]);
    if (this.failWith) throw this.failWith;
    return { id: 9, url: "https://forge/c/9" };
  }
}

export function makeDeps(overrides: Partial<ProxyDeps> & { agentOverride?: Partial<AgentRecord> } = {}) {
  const forge = new FakeForge();
  const audit = vi.fn();
  const { agentOverride, ...rest } = overrides;
  const deps: ProxyDeps = {
    agents: {
      getByFingerprint: vi.fn(async () => ({ ...agent, ...agentOverride })),
    } as never,
    nonces: permissiveNonces,
    forges: { github: forge },
    audit,
    ...rest,
  };
  return { deps, forge, audit };
}

describe("proxy gating", () => {
  it("rejects unsigned requests with 401", async () => {
    const { deps } = makeDeps();
    const app = createProxyApp(deps);
    const res = await app.request("/forge/github/repo/o/r", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("404s an unknown service", async () => {
    const { deps } = makeDeps();
    const app = createProxyApp(deps);
    const path = "/forge/gitlab/repo/o/r";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_service" });
  });

  it("403s a capability the agent lacks, with remediation text", async () => {
    const { deps } = makeDeps({ agentOverride: { capabilities: [] } });
    const app = createProxyApp(deps);
    const path = "/forge/github/repo/o/r";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("missing_capability");
    expect(body.remediation).toContain("mailctl agent tag 482913 github");
  });

  it("passes the actor to the adapter on reads", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const path = "/forge/github/repo/o/r";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(200);
    expect(forge.calls[0]).toEqual([
      "getRepo", { owner: "o", name: "r" },
      { name: "482913", email: "482913@agents.example" },
    ]);
  });
});
