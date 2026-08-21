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

  it("404s an unknown service and audits the rejection", async () => {
    const { deps, audit } = makeDeps();
    const app = createProxyApp(deps);
    const path = "/forge/gitlab/repo/o/r";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_service" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "482913", service: "gitlab", outcome: "rejected", reason: "unknown_service",
    }));
  });

  it("403s a capability the agent lacks, with remediation text, and audits it", async () => {
    const { deps, audit } = makeDeps({ agentOverride: { capabilities: [] } });
    const app = createProxyApp(deps);
    const path = "/forge/github/repo/o/r";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("missing_capability");
    expect(body.remediation).toContain("mailctl agent tag 482913 github");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "482913", service: "github", outcome: "rejected", reason: "missing_capability",
    }));
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

describe("POST /forge/:service/commit", () => {
  const path = "/forge/github/commit";
  const body = JSON.stringify({
    owner: "critical-labs", repo: "agent-identity", branch: "main",
    message: "docs: update", files: [{ path: "README.md", content: "hi" }],
  });

  it("calls the adapter with the actor as forced author", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: "c1", url: "https://forge/c1" });
    const [name, ref, spec, actor] = forge.calls[0]!;
    expect(name).toBe("createCommit");
    expect(ref).toEqual({ owner: "critical-labs", name: "agent-identity" });
    expect(spec).toEqual({
      branch: "main", message: "docs: update",
      files: [{ path: "README.md", content: "hi" }],
    });
    expect(actor).toEqual({ name: "482913", email: "482913@agents.example" });
  });

  it("ignores any author field smuggled into the request body", async () => {
    const smuggled = JSON.stringify({
      owner: "o", repo: "r", branch: "b", message: "m",
      files: [{ path: "f", content: "x" }],
      author: { name: "mallory", email: "mallory@evil" },
    });
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    await app.request(path, { ...signed("POST", path, smuggled), body: smuggled });
    const [, , , actor] = forge.calls[0]!;
    expect(actor).toEqual({ name: "482913", email: "482913@agents.example" });
  });

  it("400s a body with missing fields", async () => {
    const bad = JSON.stringify({ owner: "o", repo: "r" });
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const res = await app.request(path, { ...signed("POST", path, bad), body: bad });
    expect(res.status).toBe(400);
    expect(forge.calls).toHaveLength(0);
  });

  it("maps NonFastForward to 409 and audits the error", async () => {
    const { deps, forge, audit } = makeDeps();
    forge.failWith = new ForgeError("non_fast_forward", "stale head", 422);
    const app = createProxyApp(deps);
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("non_fast_forward");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "482913", service: "github", op: "commit",
      outcome: "error", errorKind: "non_fast_forward", upstreamStatus: 422,
    }));
  });

  it("audits successful operations", async () => {
    const { deps, audit } = makeDeps();
    const app = createProxyApp(deps);
    await app.request(path, { ...signed("POST", path, body), body });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "482913", service: "github", op: "commit",
      owner: "critical-labs", repo: "agent-identity", outcome: "ok",
    }));
  });
});

describe("POST /forge/:service/pr and /comment", () => {
  it("opens a PR with an attribution footer appended", async () => {
    const path = "/forge/github/pr";
    const body = JSON.stringify({
      owner: "o", repo: "r", head: "feat/x", base: "main",
      title: "feat: x", body: "does x",
    });
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 7, url: "https://forge/pr/7" });
    const [name, , spec] = forge.calls[0]!;
    expect(name).toBe("openPullRequest");
    expect((spec as { body: string }).body).toBe(
      "does x\n\n_opened by agent 482913 via agent-identity proxy_",
    );
  });

  it("comments with an attribution footer appended", async () => {
    const path = "/forge/github/comment";
    const body = JSON.stringify({ owner: "o", repo: "r", issue: 12, body: "note" });
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 9, url: "https://forge/c/9" });
    expect(forge.calls[0]).toEqual([
      "comment", { owner: "o", name: "r" }, 12,
      "note\n\n_comment by agent 482913 via agent-identity proxy_",
      { name: "482913", email: "482913@agents.example" },
    ]);
  });

  it("400s a comment with a non-numeric issue", async () => {
    const path = "/forge/github/comment";
    const body = JSON.stringify({ owner: "o", repo: "r", issue: "twelve", body: "note" });
    const { deps } = makeDeps();
    const app = createProxyApp(deps);
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(400);
  });
});
