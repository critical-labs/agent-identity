import type { AgentRecord, NoncesRepo } from "@agent-identity/api";
import {
  canonicalString, generateKeypair, sign,
  type ActivityEvent, type BlobSpec, type CommitChangesSpec, type CommitSpec,
  type PrSpec, type RepoRef, type RepoVisibility, type SyncResult,
} from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createProxyApp, type ProxyDeps } from "./app.js";
import type { Author, Forge } from "./forge.js";
import { ForgeError } from "./forge.js";
import { GithubForge } from "./github.js";
import { forkNamespacePolicy } from "./policy.js";

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
  async putBlob(ref: RepoRef, spec: BlobSpec, actor: Author) {
    this.calls.push(["putBlob", ref, spec, actor]);
    if (this.failWith) throw this.failWith;
    return { sha: "blob1" };
  }
  async commitChanges(ref: RepoRef, spec: CommitChangesSpec, actor: Author) {
    this.calls.push(["commitChanges", ref, spec, actor]);
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
  async fork(ref: RepoRef, actor: Author) {
    this.calls.push(["fork", ref, actor]);
    if (this.failWith) throw this.failWith;
    return { owner: "fork-acct", repo: ref.name, defaultBranch: "main" };
  }
  // Overridable so a test can hand the route a result with unexpected keys.
  syncResult?: SyncResult;
  async syncFork(ref: RepoRef, branch: string, actor: Author) {
    this.calls.push(["syncFork", ref, branch, actor]);
    if (this.failWith) throw this.failWith;
    return this.syncResult ?? {
      mergeType: "fast-forward" as const, baseBranch: "critical-labs:main",
      message: "Successfully fetched and fast-forwarded from upstream critical-labs:main",
    };
  }
  // Visibility knob: a single value, or per-ref for fork tests.
  visibility: RepoVisibility | ((ref: RepoRef) => RepoVisibility) = "public";
  visibilityError?: Error;
  async repoVisibility(ref: RepoRef, actor: Author): Promise<RepoVisibility> {
    this.calls.push(["repoVisibility", ref, actor]);
    if (this.visibilityError) throw this.visibilityError;
    return typeof this.visibility === "function" ? this.visibility(ref) : this.visibility;
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

describe("POST /forge/:service/blob", () => {
  const path = "/forge/github/blob";

  it("uploads a blob via the adapter with the actor and returns the sha", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const body = JSON.stringify({ owner: "fork-acct", repo: "r", contentBase64: "QUJD" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: "blob1" });
    expect(forge.calls[0]).toEqual([
      "putBlob", { owner: "fork-acct", name: "r" }, { contentBase64: "QUJD" },
      { name: "482913", email: "482913@agents.example" },
    ]);
  });

  it("400s a blob request missing contentBase64, writing nothing", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const body = JSON.stringify({ owner: "o", repo: "r" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(400);
    expect(forge.calls).toHaveLength(0);
  });

  it("400s a blob whose repo dot-segments out of the namespace, writing nothing", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const body = JSON.stringify({
      owner: "fork-acct", repo: "proxy/../../critical-labs/agent-identity", contentBase64: "QQ==",
    });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(400);
    expect(forge.calls).toHaveLength(0);
  });

  it("a fork-namespace policy denial creates NOTHING (no putBlob call)", async () => {
    const { deps, forge } = makeDeps({
      policy: forkNamespacePolicy({ githubForkOwner: "fork-acct" }),
    });
    const app = createProxyApp(deps);
    const body = JSON.stringify({ owner: "critical-labs", repo: "agent-identity", contentBase64: "QQ==" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("denied");
    expect(forge.calls.some((c) => c[0] === "putBlob")).toBe(false);
  });
});

describe("POST /forge/:service/commit-changes", () => {
  const path = "/forge/github/commit-changes";
  const body = JSON.stringify({
    owner: "fork-acct", repo: "agent-identity", branch: "feat-x", message: "feat: big",
    changes: [
      { path: "add.bin", blobSha: "b1" },
      { path: "keep.txt", content: "x" },
      { path: "gone.txt", deleted: true },
    ],
  });

  it("calls commitChanges with the actor as forced author", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: "c1", url: "https://forge/c1" });
    const [name, ref, spec, actor] = forge.calls[0]!;
    expect(name).toBe("commitChanges");
    expect(ref).toEqual({ owner: "fork-acct", name: "agent-identity" });
    expect(spec).toEqual({
      branch: "feat-x", message: "feat: big",
      changes: [
        { path: "add.bin", blobSha: "b1" },
        { path: "keep.txt", content: "x" },
        { path: "gone.txt", deleted: true },
      ],
    });
    expect(actor).toEqual({ name: "482913", email: "482913@agents.example" });
  });

  it("ignores any author smuggled into the body", async () => {
    const smuggled = JSON.stringify({
      owner: "fork-acct", repo: "r", branch: "b", message: "m",
      changes: [{ path: "f", blobSha: "b1" }],
      author: { name: "mallory", email: "mallory@evil" },
    });
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    await app.request(path, { ...signed("POST", path, smuggled), body: smuggled });
    const [, , , actor] = forge.calls[0]!;
    expect(actor).toEqual({ name: "482913", email: "482913@agents.example" });
  });

  it("400s an empty or malformed changes set, writing nothing", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    for (const bad of [
      { owner: "o", repo: "r", branch: "b", message: "m", changes: [] },
      { owner: "o", repo: "r", branch: "b", message: "m", changes: [{ path: "f" }] },
      { owner: "o", repo: "r", branch: "b", message: "m" },
    ]) {
      const bb = JSON.stringify(bad);
      const res = await app.request(path, { ...signed("POST", path, bb), body: bb });
      expect(res.status).toBe(400);
    }
    expect(forge.calls).toHaveLength(0);
  });

  it("writes an attested forge_commit event with the visibility stamp", async () => {
    const ledger = new FakeLedger();
    const { deps } = makeDeps({ activity: ledger });
    const app = createProxyApp(deps);
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toEqual(expect.objectContaining({
      class: "attested", type: "forge_commit",
      detail: expect.objectContaining({
        repo: "fork-acct/agent-identity", branch: "feat-x", sha: "c1", visibility: "public",
      }),
      ref: "https://forge/c1",
    }));
  });

  it("a fork-namespace policy denial creates NOTHING (no commitChanges call)", async () => {
    const { deps, forge } = makeDeps({
      policy: forkNamespacePolicy({ githubForkOwner: "fork-acct" }),
    });
    const app = createProxyApp(deps);
    const offBody = JSON.stringify({
      owner: "critical-labs", repo: "agent-identity", branch: "b", message: "m",
      changes: [{ path: "f", blobSha: "b1" }],
    });
    const res = await app.request(path, { ...signed("POST", path, offBody), body: offBody });
    expect(res.status).toBe(403);
    expect(forge.calls.some((c) => c[0] === "commitChanges")).toBe(false);
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

describe("POST /forge/:service/provision", () => {
  it("provisions via the registered provisioner and audits", async () => {
    const provision = vi.fn(async () => ({ username: "agent-482913", email: "482913@agents.example" }));
    const { deps, audit } = makeDeps({
      agentOverride: { capabilities: ["github", "gitlab"] },
      forges: { github: new FakeForge(), gitlab: new FakeForge() },
      provisioners: { gitlab: { provision } },
    });
    const app = createProxyApp(deps);
    const path = "/forge/gitlab/provision";
    const res = await app.request(path, signed("POST", path));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "agent-482913", email: "482913@agents.example" });
    expect(provision).toHaveBeenCalledWith({ name: "482913", email: "482913@agents.example" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "482913", service: "gitlab", op: "provision", outcome: "ok",
    }));
  });

  it("404s provisioning on a service without a provisioner", async () => {
    const { deps } = makeDeps();
    const app = createProxyApp(deps);
    const path = "/forge/github/provision";
    const res = await app.request(path, signed("POST", path));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("provisioning_unsupported");
  });

  it("does not echo admin-context detail on a provision error", async () => {
    const provision = vi.fn(async () => {
      throw new ForgeError("upstream_auth", "admin token bad: group 42 service_accounts detail", 401);
    });
    const { deps } = makeDeps({
      agentOverride: { capabilities: ["github", "gitlab"] },
      forges: { github: new FakeForge(), gitlab: new FakeForge() },
      provisioners: { gitlab: { provision } },
    });
    const app = createProxyApp(deps);
    const path = "/forge/gitlab/provision";
    const res = await app.request(path, signed("POST", path));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_credential_invalid" });
  });
});

describe("POST /forge/:service/fork", () => {
  it("forks via the adapter with the actor and returns fork coordinates", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    const path = "/forge/github/fork";
    const body = JSON.stringify({ owner: "critical-labs", repo: "agent-identity" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owner: "fork-acct", repo: "agent-identity", defaultBranch: "main" });
    const [name, ref, actor] = forge.calls.at(-1)!;
    expect(name).toBe("fork");
    expect(ref).toEqual({ owner: "critical-labs", name: "agent-identity" });
    expect(actor).toEqual({ name: "482913", email: "482913@agents.example" });
  });

  it("400s a fork request missing fields", async () => {
    const { deps } = makeDeps();
    const app = createProxyApp(deps);
    const path = "/forge/github/fork";
    const body = JSON.stringify({ owner: "o" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(400);
  });
});

describe("POST /forge/:service/sync", () => {
  const path = "/forge/github/sync";

  it("syncs the named fork branch via the adapter and writes a forge_sync event with the stamp", async () => {
    const ledger = new FakeLedger();
    const { deps, forge } = makeDeps({ activity: ledger });
    const app = createProxyApp(deps);
    const body = JSON.stringify({ owner: "fork-acct", repo: "agent-identity", branch: "main" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mergeType: "fast-forward", baseBranch: "critical-labs:main",
      message: "Successfully fetched and fast-forwarded from upstream critical-labs:main",
    });
    const sync = forge.calls.find((c) => c[0] === "syncFork")!;
    expect(sync).toEqual(["syncFork", { owner: "fork-acct", name: "agent-identity" }, "main",
      { name: "482913", email: "482913@agents.example" }]);
    // An explicit branch needs no repo read.
    expect(forge.calls.some((c) => c[0] === "getRepo")).toBe(false);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toEqual(expect.objectContaining({
      agentId: "482913", class: "attested", type: "forge_sync",
      summary: "synced fork-acct/agent-identity@main from upstream (fast-forward)",
      detail: {
        service: "github", fork: "fork-acct/agent-identity", branch: "main",
        mergeType: "fast-forward", visibility: "public",
      },
    }));
    expect(ledger.events[0]!.ref).toBeUndefined();
  });

  it("defaults a missing branch to the fork's default branch, read behind the policy gate", async () => {
    const ledger = new FakeLedger();
    const { deps, forge, audit } = makeDeps({ activity: ledger });
    const app = createProxyApp(deps);
    const body = JSON.stringify({ owner: "fork-acct", repo: "agent-identity" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    const names = forge.calls.map((c) => c[0]);
    expect(names.indexOf("getRepo")).toBeLessThan(names.indexOf("syncFork"));
    const sync = forge.calls.find((c) => c[0] === "syncFork")!;
    expect(sync[1]).toEqual({ owner: "fork-acct", name: "agent-identity" });
    expect(sync[2]).toBe("main");
    expect(ledger.events[0]!.summary).toBe("synced fork-acct/agent-identity@main from upstream (fast-forward)");
    expect(ledger.events[0]!.detail).toEqual(expect.objectContaining({ branch: "main" }));
    // The audit line — the record that exists even without a ledger — names
    // the branch that was actually moved and the forge's verdict, since the
    // op alone cannot carry a branch the caller never sent.
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      op: "sync", owner: "fork-acct", repo: "agent-identity", outcome: "ok",
      branch: "main", mergeType: "fast-forward",
    }));
  });

  it("never lets a route's extra audit fields relabel who did what", async () => {
    // The sync route's okFields are { branch, mergeType }; a forge that
    // answered with identity-shaped keys must not reach the audit line
    // under the base keys, which are spread last.
    const { deps, forge, audit } = makeDeps();
    forge.syncResult = {
      mergeType: "fast-forward", baseBranch: "critical-labs:main", message: "ok",
      agentId: "someone-else", op: "commit",
    } as never;
    const app = createProxyApp(deps);
    const body = JSON.stringify({ owner: "fork-acct", repo: "agent-identity", branch: "main" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "482913", op: "sync", owner: "fork-acct", repo: "agent-identity", outcome: "ok",
    }));
  });

  it("stamps private when the fork is not world-readable", async () => {
    const ledger = new FakeLedger();
    const { deps, forge } = makeDeps({ activity: ledger });
    forge.visibility = "private";
    const app = createProxyApp(deps);
    const body = JSON.stringify({ owner: "fork-acct", repo: "agent-identity", branch: "main" });
    await app.request(path, { ...signed("POST", path, body), body });
    expect(ledger.events[0]!.detail).toEqual(expect.objectContaining({ visibility: "private" }));
  });

  it("a fork-namespace policy denial touches NOTHING (no read, no sync)", async () => {
    const { deps, forge, audit } = makeDeps({
      policy: forkNamespacePolicy({ githubForkOwner: "fork-acct" }),
    });
    const app = createProxyApp(deps);
    const body = JSON.stringify({ owner: "critical-labs", repo: "agent-identity" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("denied");
    expect(forge.calls).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      op: "sync", owner: "critical-labs", outcome: "denied",
    }));
  });

  it("turns the adapter's fork_diverged into a 409 the agent can act on", async () => {
    const { deps, forge } = makeDeps();
    forge.failWith = new ForgeError("fork_diverged",
      "fork-acct/agent-identity@feat is ahead of its upstream and cannot be fast-forwarded; "
      + "the proxy never merges on the agent's behalf, so start a new branch from the fresh base instead",
      409);
    const app = createProxyApp(deps);
    const body = JSON.stringify({ owner: "fork-acct", repo: "agent-identity", branch: "feat" });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "fork_diverged", detail: expect.stringContaining("start a new branch"),
    });
  });

  it("400s a malformed sync body, writing nothing", async () => {
    const { deps, forge } = makeDeps();
    const app = createProxyApp(deps);
    for (const bad of [
      { owner: "o" },
      { owner: "o", repo: "r", branch: "" },
      { owner: "o", repo: "r", branch: "../main" },
      { owner: "fork-acct", repo: "proxy/../../critical-labs/agent-identity" },
    ]) {
      const bb = JSON.stringify(bad);
      const res = await app.request(path, { ...signed("POST", path, bb), body: bb });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(forge.calls).toHaveLength(0);
  });
});

class FakeLedger {
  events: ActivityEvent[] = [];
  failWith?: Error;
  putEvent = async (event: ActivityEvent): Promise<string> => {
    if (this.failWith) throw this.failWith;
    this.events.push(event);
    return "id";
  };
}

describe("attested activity ledger", () => {
  const commitPath = "/forge/github/commit";
  const commitBody = JSON.stringify({
    owner: "o", repo: "r", branch: "b", message: "m",
    files: [{ path: "f", content: "x" }],
  });

  function ledgered(over: Parameters<typeof makeDeps>[0] = {}) {
    const ledger = new FakeLedger();
    const made = makeDeps({ activity: ledger, ...over });
    return { ...made, ledger };
  }

  it("writes an attested forge_commit event on success", async () => {
    const { deps, ledger } = ledgered();
    const app = createProxyApp(deps);
    const res = await app.request(commitPath, { ...signed("POST", commitPath, commitBody), body: commitBody });
    expect(res.status).toBe(200);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toEqual(expect.objectContaining({
      agentId: "482913", class: "attested", type: "forge_commit",
      detail: expect.objectContaining({ repo: "o/r", branch: "b", sha: "c1" }),
      ref: "https://forge/c1",
    }));
    expect(typeof ledger.events[0].ts).toBe("string");
  });

  it("writes forge_pr, forge_comment, and forge_fork events on success", async () => {
    const { deps, ledger } = ledgered();
    const app = createProxyApp(deps);

    const prPath = "/forge/github/pr";
    const prBody = JSON.stringify({ owner: "o", repo: "r", head: "h", base: "main", title: "t", body: "b" });
    await app.request(prPath, { ...signed("POST", prPath, prBody), body: prBody });

    const cPath = "/forge/github/comment";
    const cBody = JSON.stringify({ owner: "o", repo: "r", issue: 12, body: "note" });
    await app.request(cPath, { ...signed("POST", cPath, cBody), body: cBody });

    const fPath = "/forge/github/fork";
    const fBody = JSON.stringify({ owner: "o", repo: "r" });
    await app.request(fPath, { ...signed("POST", fPath, fBody), body: fBody });

    expect(ledger.events.map((e) => e.type)).toEqual(["forge_pr", "forge_comment", "forge_fork"]);
    expect(ledger.events[0].detail).toEqual(expect.objectContaining({ repo: "o/r", number: 7 }));
    expect(ledger.events[0].ref).toBe("https://forge/pr/7");
    expect(ledger.events[1].detail).toEqual(expect.objectContaining({ repo: "o/r", issue: 12 }));
    expect(ledger.events[2].detail).toEqual(expect.objectContaining({
      source: "o/r", fork: "fork-acct/r",
    }));
  });

  it("stamps detail.visibility 'public' on forge events when the forge reports the repo public", async () => {
    const { deps, ledger, forge } = ledgered();
    const app = createProxyApp(deps);
    const res = await app.request(commitPath, { ...signed("POST", commitPath, commitBody), body: commitBody });
    expect(res.status).toBe(200);
    expect(ledger.events[0].detail?.visibility).toBe("public");
    // stamped from the forge's answer for the event's OWN repo
    expect(forge.calls).toContainEqual([
      "repoVisibility", { owner: "o", name: "r" },
      { name: "482913", email: "482913@agents.example" },
    ]);
  });

  it("stamps detail.visibility 'private' when the forge reports the repo private", async () => {
    const { deps, ledger, forge } = ledgered();
    forge.visibility = "private";
    const app = createProxyApp(deps);
    const res = await app.request(commitPath, { ...signed("POST", commitPath, commitBody), body: commitBody });
    expect(res.status).toBe(200);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0].detail?.visibility).toBe("private");
  });

  it("a failed visibility lookup writes the event WITHOUT a stamp — fail closed publicly, op unharmed", async () => {
    const { deps, ledger, forge } = ledgered();
    forge.visibilityError = new Error("github 500");
    const app = createProxyApp(deps);
    const res = await app.request(commitPath, { ...signed("POST", commitPath, commitBody), body: commitBody });
    expect(res.status).toBe(200);
    expect(ledger.events).toHaveLength(1);
    // No stamp at all: the public tier requires the exact string "public",
    // so an unstamped event can never be shown there.
    expect(ledger.events[0].detail).not.toHaveProperty("visibility");
  });

  it("forge_fork stamps 'public' only when BOTH source and fork are public", async () => {
    const fPath = "/forge/github/fork";
    const fBody = JSON.stringify({ owner: "o", repo: "r" });

    const pub = ledgered();
    await createProxyApp(pub.deps).request(fPath, { ...signed("POST", fPath, fBody), body: fBody });
    expect(pub.ledger.events[0].detail?.visibility).toBe("public");

    const mixed = ledgered();
    // the fork landed in a namespace whose copy reads private
    mixed.forge.visibility = (ref) => (ref.owner === "fork-acct" ? "private" : "public");
    await createProxyApp(mixed.deps).request(fPath, { ...signed("POST", fPath, fBody), body: fBody });
    expect(mixed.ledger.events[0].detail?.visibility).toBe("private");
  });

  it("maps provision to capability_granted and never records username or address", async () => {
    const provision = vi.fn(async () => ({ username: "agent-482913", email: "482913@agents.example" }));
    const { deps, ledger } = ledgered({
      agentOverride: { capabilities: ["github", "gitlab"] },
      forges: { github: new FakeForge(), gitlab: new FakeForge() },
      provisioners: { gitlab: { provision } },
    });
    const app = createProxyApp(deps);
    const path = "/forge/gitlab/provision";
    const res = await app.request(path, signed("POST", path));
    expect(res.status).toBe(200);
    expect(ledger.events[0]).toEqual(expect.objectContaining({
      class: "attested", type: "capability_granted",
      detail: { service: "gitlab" },
    }));
    const json = JSON.stringify(ledger.events);
    expect(json).not.toContain("agent-482913");
    expect(json).not.toContain("482913@agents.example");
  });

  it("writes no event on a failed forge operation", async () => {
    const { deps, forge, ledger } = ledgered();
    forge.failWith = new ForgeError("non_fast_forward", "stale", 422);
    const app = createProxyApp(deps);
    await app.request(commitPath, { ...signed("POST", commitPath, commitBody), body: commitBody });
    expect(ledger.events).toHaveLength(0);
  });

  it("writes no event on a policy denial", async () => {
    const { deps, ledger } = ledgered({ policy: () => ({ allow: false, reason: "no" }) });
    const app = createProxyApp(deps);
    await app.request(commitPath, { ...signed("POST", commitPath, commitBody), body: commitBody });
    expect(ledger.events).toHaveLength(0);
  });

  it("never records read-only repo lookups", async () => {
    const { deps, ledger } = ledgered();
    const app = createProxyApp(deps);
    const path = "/forge/github/repo/o/r";
    await app.request(path, signed("GET", path));
    expect(ledger.events).toHaveLength(0);
  });

  it("swallows a ledger write failure: the forge op still succeeds, audited", async () => {
    const { deps, ledger, audit } = ledgered();
    ledger.failWith = new Error("ddb down");
    const app = createProxyApp(deps);
    const res = await app.request(commitPath, { ...signed("POST", commitPath, commitBody), body: commitBody });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: "c1", url: "https://forge/c1" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "ledger_write_failed",
    }));
  });
});

describe("policy enforcement", () => {
  it("denies a commit the injected policy rejects, before calling the adapter, and audits it", async () => {
    const denyOffFork: import("./policy.js").Policy = (_a, op) =>
      op.kind === "commit" && op.owner !== "fork-acct"
        ? { allow: false, reason: "off-fork" }
        : { allow: true };
    const { deps, forge, audit } = makeDeps({ policy: denyOffFork });
    const app = createProxyApp(deps);
    const path = "/forge/github/commit";
    const body = JSON.stringify({
      owner: "critical-labs", repo: "agent-identity", branch: "main",
      message: "m", files: [{ path: "f", content: "x" }],
    });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("denied");
    expect(forge.calls.some((c) => c[0] === "createCommit")).toBe(false);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("fork-namespace rejection fires before branch auto-creation: no upstream request at all", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    const github = new GithubForge({
      credentials: {
        resolve: async () => "tok", resolveCommitToken: async () => "tok",
        resolveCommitSigner: async () => undefined,
      },
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const { deps } = makeDeps({
      forges: { github },
      policy: forkNamespacePolicy({ githubForkOwner: "fork-acct" }),
    });
    const app = createProxyApp(deps);
    const path = "/forge/github/commit";
    const body = JSON.stringify({
      owner: "critical-labs", repo: "agent-identity", branch: "feat-x",
      message: "m", files: [{ path: "f", content: "x" }],
    });
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("denied");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
