# Forge Access Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/forge/{service}/*` proxy Lambda that holds forge credentials centrally and executes typed operations (commit, PR/MR, comment, repo info, provision) on behalf of Ed25519-authenticated agent identities, with authorship forced to the calling identity. Two adapters: GitHub (shared PAT) and GitLab (per-identity service accounts).

**Architecture:** New `packages/proxy` Hono Lambda in the existing CDK stack, reusing `signatureAuth` and the DynamoDB repos from `@agent-identity/api`. Handlers depend on a forge-neutral `Forge` port taking an `actor` on every call; credential resolution is per-identity-first with shared fallback out of SSM. `GitlabProvisioner` self-onboards identities as GitLab group service accounts whose email is the agent's own mailbox.

**Tech Stack:** TypeScript ESM, Hono, vitest, AWS CDK, `@aws-sdk/client-ssm`. Spec: `docs/superpowers/specs/2026-08-20-forge-access-proxy-design.md`.

**Delivery:** Tasks 1–14 are PR 1 (proxy + GitHub). Tasks 15–20 are PR 2 (GitLab + provisioning), branched after PR 1 merges.

**Conventions:** every command runs from the repo root. `pnpm vitest run <file>` runs one file; `npx tsc --noEmit -p tsconfig.base.json` typechecks everything. Commit after every green step. PR 1 work on branch `feat/forge-access-proxy`; PR 2 on `feat/forge-gitlab` (from updated main).

---

## Phase 1 — proxy + GitHub adapter (PR 1)

### Task 1: Forge DTO types in shared

**Files:**
- Modify: `packages/shared/src/types.ts` (append at end)

- [ ] **Step 1: Append the forge-neutral DTOs**

Append to the end of `packages/shared/src/types.ts`:

```ts
// --- forge proxy DTOs (see docs/superpowers/specs/2026-08-20-forge-access-proxy-design.md) ---

export interface RepoRef {
  owner: string;
  name: string;
}

export interface ForgeFile {
  path: string;
  content: string;
}

export interface CommitSpec {
  branch: string;
  message: string;
  files: ForgeFile[];
}

export interface PrSpec {
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface RepoInfo {
  defaultBranch: string;
  headSha: string;
}

export interface CommitResult {
  sha: string;
  url: string;
}

export interface PrResult {
  number: number;
  url: string;
}

export interface CommentResult {
  id: number;
  url: string;
}

export interface ForgeProvisionResult {
  username: string;
  email: string;
}
```

If `packages/shared/src/index.ts` does not already re-export types via `export * from "./types.js"` (check it), add explicit re-exports for these names in the same style the file already uses.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.base.json`
Expected: `TypeScript compilation completed`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts
git commit -m "feat(shared): forge-neutral DTO types for the access proxy"
```

---

### Task 2: Export signatureAuth from the api package

**Files:**
- Modify: `packages/api/src/index.ts`

- [ ] **Step 1: Add the export**

`packages/api/src/index.ts` currently exports repos and `createApp`. Add:

```ts
export { signatureAuth } from "./auth.js";
```

- [ ] **Step 2: Typecheck and run api tests**

Run: `npx tsc --noEmit -p tsconfig.base.json && pnpm vitest run packages/api`
Expected: tsc clean; all api tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): export signatureAuth for reuse by the proxy Lambda"
```

---

### Task 3: Proxy package scaffold + Forge port

**Files:**
- Create: `packages/proxy/package.json`
- Create: `packages/proxy/src/forge.ts`
- Test: `packages/proxy/src/forge.test.ts`

- [ ] **Step 1: Create the package manifest**

`packages/proxy/package.json`:

```json
{
  "name": "@agent-identity/proxy",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/app.ts" },
  "dependencies": {
    "@agent-identity/api": "workspace:*",
    "@agent-identity/shared": "workspace:*",
    "@aws-sdk/client-dynamodb": "^3.600.0",
    "@aws-sdk/client-ssm": "^3.600.0",
    "@aws-sdk/lib-dynamodb": "^3.600.0",
    "hono": "^4.5.0"
  }
}
```

Run: `pnpm install`
Expected: lockfile updated, workspace links created.

- [ ] **Step 2: Write the failing test**

`packages/proxy/src/forge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ForgeError, statusFor } from "./forge.js";

describe("ForgeError", () => {
  it("maps each kind to its HTTP status", () => {
    expect(statusFor("not_found")).toBe(404);
    expect(statusFor("non_fast_forward")).toBe(409);
    expect(statusFor("rate_limited")).toBe(429);
    expect(statusFor("upstream_auth")).toBe(502);
    expect(statusFor("invalid")).toBe(400);
    expect(statusFor("not_provisioned")).toBe(403);
  });

  it("carries kind and optional upstream status", () => {
    const err = new ForgeError("rate_limited", "slow down", 403);
    expect(err.kind).toBe("rate_limited");
    expect(err.upstream).toBe(403);
    expect(err.message).toBe("slow down");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/proxy/src/forge.test.ts`
Expected: FAIL — cannot resolve `./forge.js`.

- [ ] **Step 4: Write the port module**

`packages/proxy/src/forge.ts`:

```ts
import type {
  CommentResult, CommitResult, CommitSpec, PrResult, PrSpec, ForgeProvisionResult,
  RepoInfo, RepoRef,
} from "@agent-identity/shared";

/** The acting identity: name is the agentId, email its mailbox address.
 *  Constructed by the core from the authenticated agent record only. */
export interface Author {
  name: string;
  email: string;
}

export type ForgeErrorKind =
  | "not_found" | "non_fast_forward" | "rate_limited" | "upstream_auth"
  | "invalid" | "not_provisioned";

const STATUS: Record<ForgeErrorKind, number> = {
  not_found: 404,
  non_fast_forward: 409,
  rate_limited: 429,
  upstream_auth: 502,
  invalid: 400,
  not_provisioned: 403,
};

export const statusFor = (kind: ForgeErrorKind): number => STATUS[kind];

export class ForgeError extends Error {
  constructor(
    public readonly kind: ForgeErrorKind,
    message: string,
    public readonly upstream?: number,
  ) {
    super(message);
  }
}

/** The hexagon's outbound port. Every operation executes AS an identity:
 *  actor is supplied by the core from the authenticated record — adapters
 *  must never accept caller-controlled authorship, and per-identity
 *  adapters (gitlab) resolve the actor's own credential from actor.name. */
export interface Forge {
  getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo>;
  createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult>;
  openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult>;
  comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult>;
}

export interface CredentialStore {
  /** Per-identity parameter first, shared fallback; throws
   *  ForgeError("not_provisioned") when neither exists. */
  resolve(service: string, agentId: string): Promise<string>;
}

export interface Provisioner {
  provision(actor: Author): Promise<ForgeProvisionResult>;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/proxy/src/forge.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/proxy/package.json packages/proxy/src/forge.ts packages/proxy/src/forge.test.ts pnpm-lock.yaml
git commit -m "feat(proxy): package scaffold and forge port with error taxonomy"
```

---

### Task 4: Policy stub

**Files:**
- Create: `packages/proxy/src/policy.ts`
- Test: `packages/proxy/src/policy.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/proxy/src/policy.test.ts`:

```ts
import type { AgentRecord } from "@agent-identity/api";
import { describe, expect, it } from "vitest";
import { evaluate } from "./policy.js";

const agent: AgentRecord = {
  agentId: "482913", address: "482913@d", publicKey: "pk",
  status: "active", createdAt: "t", capabilities: ["github"],
};

describe("policy", () => {
  it("allows everything in the MVP", () => {
    expect(evaluate(agent, {
      service: "github", kind: "commit", owner: "critical-labs", repo: "agent-identity",
    })).toEqual({ allow: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/proxy/src/policy.test.ts`
Expected: FAIL — cannot resolve `./policy.js`.

- [ ] **Step 3: Write the stub**

`packages/proxy/src/policy.ts`:

```ts
import type { AgentRecord } from "@agent-identity/api";

/** The parsed, typed operation — exactly what issue #23's deterministic
 *  rules will pattern-match on. */
export interface ForgeOp {
  service: string;
  kind: "repo" | "commit" | "pr" | "comment" | "provision";
  owner: string;
  repo: string;
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

// Allow-all in the #22 MVP; #23 replaces the body, not the signature.
export function evaluate(_agent: AgentRecord, _op: ForgeOp): PolicyDecision {
  return { allow: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/proxy/src/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/policy.ts packages/proxy/src/policy.test.ts
git commit -m "feat(proxy): allow-all policy seam for issue #23"
```

---

### Task 5: Proxy app — gating (auth, unknown service, capability)

**Files:**
- Create: `packages/proxy/src/app.ts`
- Test: `packages/proxy/src/app.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/proxy/src/app.test.ts` — signed-request helper and fakes mirror `packages/api/src/app.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/app.test.ts`
Expected: FAIL — cannot resolve `./app.js`.

- [ ] **Step 3: Write the app with gating and the repo route**

`packages/proxy/src/app.ts`:

```ts
import {
  signatureAuth, type AgentRecord, type AgentsRepo, type NoncesRepo,
} from "@agent-identity/api";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  ForgeError, statusFor, type Author, type Forge, type Provisioner,
} from "./forge.js";
import { evaluate, type ForgeOp } from "./policy.js";

export interface ProxyDeps {
  agents: AgentsRepo;
  nonces: NoncesRepo;
  forges: Record<string, Forge>;
  provisioners?: Record<string, Provisioner>;
  audit?: (line: Record<string, unknown>) => void;
}

interface Guarded {
  service: string;
  forge: Forge;
  agent: AgentRecord;
  actor: Author;
}

export function createProxyApp(deps: ProxyDeps): Hono {
  const app = new Hono();
  const audit = deps.audit ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  app.use("*", signatureAuth(deps.agents, deps.nonces));

  const guard = (c: Context): Guarded | Response => {
    const service = c.req.param("service");
    if (!service) return c.json({ error: "unknown_service" }, 404);
    const forge = deps.forges[service];
    if (!forge) return c.json({ error: "unknown_service" }, 404);
    const agent = c.get("agent") as AgentRecord;
    if (!(agent.capabilities ?? []).includes(service)) {
      return c.json({
        error: "missing_capability",
        remediation: `ask the operator to run: mailctl agent tag ${agent.agentId} ${service}`,
      }, 403);
    }
    return { service, forge, agent, actor: { name: agent.agentId, email: agent.address } };
  };

  const run = async <T>(
    c: Context, g: Guarded, op: ForgeOp, call: () => Promise<T>,
  ): Promise<Response> => {
    const decision = evaluate(g.agent, op);
    if (!decision.allow) return c.json({ error: "denied", reason: decision.reason }, 403);
    const started = Date.now();
    const base = {
      agentId: g.agent.agentId, service: op.service, op: op.kind,
      owner: op.owner, repo: op.repo,
    };
    try {
      const result = await call();
      audit({ ...base, outcome: "ok", latencyMs: Date.now() - started });
      return c.json(result as object);
    } catch (err) {
      if (err instanceof ForgeError) {
        audit({
          ...base, outcome: "error", errorKind: err.kind,
          upstreamStatus: err.upstream, latencyMs: Date.now() - started,
        });
        const label = err.kind === "upstream_auth" ? "upstream_credential_invalid" : err.kind;
        return c.json({ error: label, detail: err.message }, statusFor(err.kind) as never);
      }
      throw err;
    }
  };

  app.get("/forge/:service/repo/:owner/:repo", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const { owner, repo } = c.req.param();
    const op: ForgeOp = { service: g.service, kind: "repo", owner, repo };
    return run(c, g, op, () => g.forge.getRepo({ owner, name: repo }, g.actor));
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/proxy/src/app.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/app.ts packages/proxy/src/app.test.ts
git commit -m "feat(proxy): app gating — signature auth, service registry, capability check"
```

---

### Task 6: Proxy app — commit route with forced author

**Files:**
- Modify: `packages/proxy/src/app.ts`
- Test: `packages/proxy/src/app.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `app.test.ts`)

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/app.test.ts`
Expected: the five new tests FAIL with 404s (route not defined); gating tests still pass.

- [ ] **Step 3: Add validation helpers and the commit route** (inside `createProxyApp`, before `return app;`)

```ts
  const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const isFiles = (v: unknown): v is { path: string; content: string }[] =>
    Array.isArray(v) && v.length > 0 &&
    v.every((f) => isStr((f as { path?: unknown }).path) &&
      typeof (f as { content?: unknown }).content === "string");

  app.post("/forge/:service/commit", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo) || !isStr(b.branch)
      || !isStr(b.message) || !isFiles(b.files)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "commit", owner: b.owner, repo: b.repo };
    return run(c, g, op, () => g.forge.createCommit(
      { owner: b.owner as string, name: b.repo as string },
      {
        branch: b.branch as string, message: b.message as string,
        files: b.files as { path: string; content: string }[],
      },
      g.actor,
    ));
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/proxy/src/app.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/app.ts packages/proxy/src/app.test.ts
git commit -m "feat(proxy): commit route — validation, forced author, audit, error mapping"
```

---

### Task 7: Proxy app — PR and comment routes with attribution footers

**Files:**
- Modify: `packages/proxy/src/app.ts`
- Test: `packages/proxy/src/app.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `app.test.ts`)

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/app.test.ts`
Expected: the three new tests FAIL (404 route not defined).

- [ ] **Step 3: Add the routes** (inside `createProxyApp`, after the commit route)

```ts
  app.post("/forge/:service/pr", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo) || !isStr(b.head)
      || !isStr(b.base) || !isStr(b.title) || typeof b.body !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "pr", owner: b.owner, repo: b.repo };
    const footer = `\n\n_opened by agent ${g.agent.agentId} via agent-identity proxy_`;
    return run(c, g, op, () => g.forge.openPullRequest(
      { owner: b.owner as string, name: b.repo as string },
      {
        head: b.head as string, base: b.base as string,
        title: b.title as string, body: `${b.body}${footer}`,
      },
      g.actor,
    ));
  });

  app.post("/forge/:service/comment", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo)
      || !Number.isInteger(b.issue) || typeof b.body !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "comment", owner: b.owner, repo: b.repo };
    const footer = `\n\n_comment by agent ${g.agent.agentId} via agent-identity proxy_`;
    return run(c, g, op, () => g.forge.comment(
      { owner: b.owner as string, name: b.repo as string },
      b.issue as number, `${b.body}${footer}`, g.actor,
    ));
  });
```

- [ ] **Step 4: Run the full proxy test file**

Run: `pnpm vitest run packages/proxy/src/app.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/app.ts packages/proxy/src/app.test.ts
git commit -m "feat(proxy): pr and comment routes with per-identity attribution footers"
```

---

### Task 8: GitHub adapter

**Files:**
- Create: `packages/proxy/src/github.ts`
- Test: `packages/proxy/src/github.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/proxy/src/github.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "./forge.js";
import { GithubForge } from "./github.js";

const credentials: CredentialStore = { resolve: async () => "tok123" };
const actor = { name: "482913", email: "482913@agents.example" };

/** fetch fake: responds per "METHOD url" from a routing table; records calls. */
function makeFetch(routes: Record<string, { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    const body = route.text ?? JSON.stringify(route.json ?? {});
    return new Response(body, { status: route.status ?? 200, headers: route.headers });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const B = "https://api.github.com/repos/o/r";

describe("GithubForge.getRepo", () => {
  it("returns default branch and its head sha, resolving the actor's credential", async () => {
    const resolve = vi.fn(async () => "tok123");
    const { fn, calls } = makeFetch({
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "abc123" } } },
    });
    const forge = new GithubForge({ credentials: { resolve }, fetch: fn });
    const info = await forge.getRepo({ owner: "o", name: "r" }, actor);
    expect(info).toEqual({ defaultBranch: "main", headSha: "abc123" });
    expect(resolve).toHaveBeenCalledWith("github", "482913");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("authorization")).toBe("Bearer tok123");
  });

  it("maps 404 to not_found", async () => {
    const { fn } = makeFetch({ [`GET ${B}`]: { status: 404, json: { message: "Not Found" } } });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "not_found" });
  });

  it("maps 401 to upstream_auth", async () => {
    const { fn } = makeFetch({ [`GET ${B}`]: { status: 401, json: { message: "Bad credentials" } } });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "upstream_auth", upstream: 401 });
  });

  it("maps exhausted rate limit to rate_limited", async () => {
    const { fn } = makeFetch({
      [`GET ${B}`]: {
        status: 403, json: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("GithubForge.createCommit", () => {
  const routes = {
    [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "head1" } } },
    [`GET ${B}/git/commits/head1`]: { json: { tree: { sha: "tree0" } } },
    [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
    [`POST ${B}/git/commits`]: { json: { sha: "commit1", html_url: "https://github.com/o/r/commit/commit1" } },
    [`PATCH ${B}/git/refs/heads/main`]: { json: { object: { sha: "commit1" } } },
  };
  const spec = {
    branch: "main", message: "feat: x",
    files: [{ path: "a.txt", content: "A" }],
  };

  it("runs ref → base commit → tree → commit → fast-forward ref update", async () => {
    const { fn, calls } = makeFetch(routes);
    const forge = new GithubForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, spec, actor);
    expect(result).toEqual({ sha: "commit1", url: "https://github.com/o/r/commit/commit1" });

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(JSON.parse(treeCall.init.body as string)).toEqual({
      base_tree: "tree0",
      tree: [{ path: "a.txt", mode: "100644", type: "blob", content: "A" }],
    });

    const commitCall = calls.find((c) => c.url.endsWith("/git/commits") && c.init.method === "POST")!;
    expect(JSON.parse(commitCall.init.body as string)).toEqual({
      message: "feat: x", tree: "tree1", parents: ["head1"],
      author: { name: "482913", email: "482913@agents.example" },
    });

    const refCall = calls.find((c) => c.init.method === "PATCH")!;
    expect(JSON.parse(refCall.init.body as string)).toEqual({ sha: "commit1", force: false });
  });

  it("maps a non-fast-forward 422 to non_fast_forward", async () => {
    const { fn } = makeFetch({
      ...routes,
      [`PATCH ${B}/git/refs/heads/main`]: {
        status: 422, json: { message: "Update is not a fast forward" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.createCommit({ owner: "o", name: "r" }, spec, actor))
      .rejects.toMatchObject({ kind: "non_fast_forward" });
  });
});

describe("GithubForge.openPullRequest and comment", () => {
  it("opens a PR", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${B}/pulls`]: { json: { number: 5, html_url: "https://github.com/o/r/pull/5" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const pr = await forge.openPullRequest({ owner: "o", name: "r" },
      { head: "f", base: "main", title: "t", body: "b" }, actor);
    expect(pr).toEqual({ number: 5, url: "https://github.com/o/r/pull/5" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      title: "t", head: "f", base: "main", body: "b",
    });
  });

  it("comments on an issue", async () => {
    const { fn } = makeFetch({
      [`POST ${B}/issues/12/comments`]: { json: { id: 33, html_url: "https://github.com/o/r/issues/12#c33" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const c = await forge.comment({ owner: "o", name: "r" }, 12, "hello", actor);
    expect(c).toEqual({ id: 33, url: "https://github.com/o/r/issues/12#c33" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/github.test.ts`
Expected: FAIL — cannot resolve `./github.js`.

- [ ] **Step 3: Write the adapter**

`packages/proxy/src/github.ts`:

```ts
import type {
  CommentResult, CommitResult, CommitSpec, PrResult, PrSpec, RepoInfo, RepoRef,
} from "@agent-identity/shared";
import {
  ForgeError, type Author, type CredentialStore, type Forge,
} from "./forge.js";

export interface GithubForgeOptions {
  credentials: CredentialStore;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
}

export class GithubForge implements Forge {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly base: string;

  constructor(private readonly opts: GithubForgeOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.base = opts.apiBase ?? "https://api.github.com";
  }

  private async gh<T>(method: string, path: string, agentId: string, body?: unknown): Promise<T> {
    const token = await this.opts.credentials.resolve("github", agentId);
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await this.mapError(res);
    return res.json() as Promise<T>;
  }

  private async mapError(res: Response): Promise<ForgeError> {
    const text = await res.text();
    if (res.status === 401) return new ForgeError("upstream_auth", "github rejected the credential", 401);
    if (res.status === 404) return new ForgeError("not_found", "not found on github", 404);
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0"))
      return new ForgeError("rate_limited", "github rate limit exhausted", res.status);
    if (res.status === 422 && /fast forward/i.test(text))
      return new ForgeError("non_fast_forward", "ref update is not a fast forward", 422);
    return new ForgeError("invalid", `github ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  async getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo> {
    const r = `/repos/${ref.owner}/${ref.name}`;
    const repo = await this.gh<{ default_branch: string }>("GET", r, actor.name);
    const head = await this.gh<{ object: { sha: string } }>(
      "GET", `${r}/git/ref/heads/${repo.default_branch}`, actor.name);
    return { defaultBranch: repo.default_branch, headSha: head.object.sha };
  }

  async createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult> {
    const r = `/repos/${ref.owner}/${ref.name}`;
    const head = await this.gh<{ object: { sha: string } }>(
      "GET", `${r}/git/ref/heads/${spec.branch}`, actor.name);
    const baseCommit = await this.gh<{ tree: { sha: string } }>(
      "GET", `${r}/git/commits/${head.object.sha}`, actor.name);
    const tree = await this.gh<{ sha: string }>("POST", `${r}/git/trees`, actor.name, {
      base_tree: baseCommit.tree.sha,
      tree: spec.files.map((f) => ({
        path: f.path, mode: "100644", type: "blob", content: f.content,
      })),
    });
    const commit = await this.gh<{ sha: string; html_url: string }>(
      "POST", `${r}/git/commits`, actor.name, {
        message: spec.message, tree: tree.sha, parents: [head.object.sha],
        author: { name: actor.name, email: actor.email },
      });
    await this.gh("PATCH", `${r}/git/refs/heads/${spec.branch}`, actor.name,
      { sha: commit.sha, force: false });
    return { sha: commit.sha, url: commit.html_url };
  }

  async openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult> {
    const pr = await this.gh<{ number: number; html_url: string }>(
      "POST", `/repos/${ref.owner}/${ref.name}/pulls`, actor.name, {
        title: spec.title, head: spec.head, base: spec.base, body: spec.body,
      });
    return { number: pr.number, url: pr.html_url };
  }

  async comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult> {
    const c = await this.gh<{ id: number; html_url: string }>(
      "POST", `/repos/${ref.owner}/${ref.name}/issues/${issue}/comments`, actor.name, { body });
    return { id: c.id, url: c.html_url };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/proxy/src/github.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/github.ts packages/proxy/src/github.test.ts
git commit -m "feat(proxy): github adapter — git-data commit flow, error taxonomy mapping"
```

---

### Task 9: SSM credential store

**Files:**
- Create: `packages/proxy/src/ssm.ts`
- Test: `packages/proxy/src/ssm.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/proxy/src/ssm.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SsmCredentialStore } from "./ssm.js";

/** fake ssm: routes GetParameter by Name; missing names reject like the SDK. */
function makeSsm(params: Record<string, string>) {
  const send = vi.fn(async (cmd: { input: { Name?: string } }) => {
    const name = cmd.input.Name!;
    if (name in params) return { Parameter: { Value: params[name] } };
    const err = new Error("ParameterNotFound");
    err.name = "ParameterNotFound";
    throw err;
  });
  return send;
}

describe("SsmCredentialStore.resolve", () => {
  it("prefers the per-identity parameter", async () => {
    const send = makeSsm({
      "/agent-identity/forge/gitlab/pat/482913": "identity-tok",
      "/agent-identity/forge/gitlab/pat": "shared-tok",
    });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.resolve("gitlab", "482913")).toBe("identity-tok");
  });

  it("falls back to the shared parameter", async () => {
    const send = makeSsm({ "/agent-identity/forge/github/pat": "shared-tok" });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.resolve("github", "482913")).toBe("shared-tok");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("throws not_provisioned when neither exists", async () => {
    const send = makeSsm({});
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    await expect(store.resolve("gitlab", "482913"))
      .rejects.toMatchObject({ kind: "not_provisioned" });
  });

  it("caches within the TTL and refetches after it", async () => {
    const send = makeSsm({ "/agent-identity/forge/github/pat/482913": "tok" });
    let now = 1_000;
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never, () => now);
    await store.resolve("github", "482913");
    now += 60_000;
    await store.resolve("github", "482913");
    expect(send).toHaveBeenCalledTimes(1);
    now += 300_001;
    await store.resolve("github", "482913");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("SsmCredentialStore.put and getParam", () => {
  it("puts a per-identity SecureString with overwrite", async () => {
    const send = vi.fn(async (_cmd: unknown) => ({}));
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    await store.put("gitlab", "482913", "newtok");
    const cmd = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input).toEqual({
      Name: "/agent-identity/forge/gitlab/pat/482913",
      Value: "newtok", Type: "SecureString", Overwrite: true,
    });
  });

  it("getParam reads an arbitrary decrypted parameter", async () => {
    const send = makeSsm({ "/agent-identity/forge/gitlab/admin-token": "admintok" });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.getParam("/agent-identity/forge/gitlab/admin-token")).toBe("admintok");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/ssm.test.ts`
Expected: FAIL — cannot resolve `./ssm.js`.

- [ ] **Step 3: Write the store**

`packages/proxy/src/ssm.ts`:

```ts
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ForgeError, type CredentialStore } from "./forge.js";

const TTL_MS = 300_000;

export class SsmCredentialStore implements CredentialStore {
  private readonly cache = new Map<string, { value: string; at: number }>();

  constructor(
    private readonly basePath: string = "/agent-identity/forge",
    private readonly ssm: Pick<SSMClient, "send"> = new SSMClient({}),
    private readonly now: () => number = Date.now,
  ) {}

  private async tryGet(name: string): Promise<string | undefined> {
    try {
      const res = await this.ssm.send(new GetParameterCommand({
        Name: name, WithDecryption: true,
      })) as { Parameter?: { Value?: string } };
      return res.Parameter?.Value;
    } catch (err) {
      if ((err as Error).name === "ParameterNotFound") return undefined;
      throw err;
    }
  }

  async getParam(name: string): Promise<string> {
    const value = await this.tryGet(name);
    if (!value) throw new Error(`missing SSM parameter ${name}`);
    return value;
  }

  async resolve(service: string, agentId: string): Promise<string> {
    const cacheKey = `${service}/${agentId}`;
    const hit = this.cache.get(cacheKey);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.tryGet(`${this.basePath}/${service}/pat/${agentId}`)
      ?? await this.tryGet(`${this.basePath}/${service}/pat`);
    if (!value) {
      throw new ForgeError("not_provisioned",
        `no credential for ${service}; provision this identity first (POST /forge/${service}/provision)`);
    }
    this.cache.set(cacheKey, { value, at: this.now() });
    return value;
  }

  async put(service: string, agentId: string, token: string): Promise<void> {
    await this.ssm.send(new PutParameterCommand({
      Name: `${this.basePath}/${service}/pat/${agentId}`,
      Value: token, Type: "SecureString", Overwrite: true,
    }));
    this.cache.delete(`${service}/${agentId}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/proxy/src/ssm.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/ssm.ts packages/proxy/src/ssm.test.ts
git commit -m "feat(proxy): ssm credential store — per-identity resolution, ttl cache, put"
```

---

### Task 10: Lambda wiring + CDK

**Files:**
- Create: `packages/proxy/src/lambda.ts`
- Modify: `infra/lib/stack.ts`

- [ ] **Step 1: Write the Lambda entry**

`packages/proxy/src/lambda.ts`:

```ts
import { AgentsRepo, NoncesRepo } from "@agent-identity/api";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { createProxyApp } from "./app.js";
import { GithubForge } from "./github.js";
import { SsmCredentialStore } from "./ssm.js";

const table = process.env.TABLE_NAME!;
const domain = process.env.MAIL_DOMAIN!;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const credentials = new SsmCredentialStore();

const app = createProxyApp({
  agents: new AgentsRepo(ddb, table, domain),
  nonces: new NoncesRepo(ddb, table),
  forges: { github: new GithubForge({ credentials }) },
});

export const handler = handle(app);
```

- [ ] **Step 2: Add the Lambda, SSM policy, and route to the stack**

In `infra/lib/stack.ts`:

Change the apigatewayv2 import to include `HttpMethod`:

```ts
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
```

Add the iam import alongside the other imports:

```ts
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
```

After the `httpApi` declaration (currently `const httpApi = new HttpApi(...)`), add:

```ts
    const proxyFn = new NodejsFunction(this, "Proxy", {
      ...fnDefaults,
      entry: pkg("proxy/src/lambda.ts"),
    });
    table.grantReadWriteData(proxyFn);
    proxyFn.addToRolePolicy(new PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/agent-identity/forge/*`],
    }));
    httpApi.addRoutes({
      path: "/forge/{proxy+}",
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration("ProxyInt", proxyFn),
    });
```

- [ ] **Step 3: Typecheck and synth**

Run: `npx tsc --noEmit -p tsconfig.base.json`
Expected: clean.

Run: `cd infra && pnpm exec cdk synth -c domain=ci.invalid > /dev/null; echo "exit: $?"; cd ..`
Expected: `exit: 0`.

- [ ] **Step 4: Commit**

```bash
git add packages/proxy/src/lambda.ts infra/lib/stack.ts
git commit -m "feat(infra): proxy lambda on /forge/* with path-scoped ssm read access"
```

---

### Task 11: Client forge methods

**Files:**
- Modify: `packages/client/src/client.ts`
- Test: `packages/client/src/client.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `client.test.ts`)

```ts
describe("forge methods", () => {
  it("forgeCommit posts a signed body to the service path", async () => {
    const fetchMock = makeFetch({ sha: "c1", url: "u" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const result = await client.forgeCommit("github",
      { owner: "o", name: "r" },
      { branch: "main", message: "m", files: [{ path: "f", content: "x" }] });
    expect(result).toEqual({ sha: "c1", url: "u" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/forge/github/commit");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({
      owner: "o", repo: "r", branch: "main", message: "m",
      files: [{ path: "f", content: "x" }],
    });
    const h = new Headers(init.headers);
    const msg = canonicalString("POST", "/forge/github/commit", h.get("x-agent-timestamp")!, body);
    expect(verify(msg, h.get("x-agent-signature")!, kp.publicKeySpkiBase64)).toBe(true);
  });

  it("forgeRepo GETs the repo info path", async () => {
    const fetchMock = makeFetch({ defaultBranch: "main", headSha: "abc" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const info = await client.forgeRepo("github", { owner: "o", name: "r" });
    expect(info).toEqual({ defaultBranch: "main", headSha: "abc" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example/forge/github/repo/o/r");
  });

  it("forgeOpenPr and forgeComment post their bodies", async () => {
    const fetchMock = makeFetch({ number: 1, url: "u" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await client.forgeOpenPr("github", { owner: "o", name: "r" },
      { head: "h", base: "b", title: "t", body: "d" });
    await client.forgeComment("github", { owner: "o", name: "r" }, 3, "hi");
    const [url1, init1] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url2, init2] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url1).toBe("https://api.example/forge/github/pr");
    expect(JSON.parse(init1.body as string)).toEqual({
      owner: "o", repo: "r", head: "h", base: "b", title: "t", body: "d",
    });
    expect(url2).toBe("https://api.example/forge/github/comment");
    expect(JSON.parse(init2.body as string)).toEqual({
      owner: "o", repo: "r", issue: 3, body: "hi",
    });
  });

  it("forgeProvision posts to the provision path", async () => {
    const fetchMock = makeFetch({ username: "agent-482913", email: "482913@d" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const r = await client.forgeProvision("gitlab");
    expect(r).toEqual({ username: "agent-482913", email: "482913@d" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example/forge/gitlab/provision");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/client/src/client.test.ts`
Expected: the four new tests FAIL (`forgeCommit is not a function`); existing three pass.

- [ ] **Step 3: Add the methods** (in `AgentIdentityClient`, after `getEmail`)

Extend the shared import at the top of `client.ts`:

```ts
import {
  canonicalString, sign, type AgentIdentity, type CommentResult, type CommitResult,
  type CommitSpec, type EmailFull, type EmailSummary, type Keypair, type PrResult,
  type PrSpec, type ForgeProvisionResult, type RepoInfo, type RepoRef,
} from "@agent-identity/shared";
```

Add the methods:

```ts
  forgeRepo(service: string, ref: RepoRef): Promise<RepoInfo> {
    return this.request("GET", `/forge/${service}/repo/${ref.owner}/${ref.name}`);
  }

  forgeCommit(service: string, ref: RepoRef, spec: CommitSpec): Promise<CommitResult> {
    return this.request("POST", `/forge/${service}/commit`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, ...spec }));
  }

  forgeOpenPr(service: string, ref: RepoRef, spec: PrSpec): Promise<PrResult> {
    return this.request("POST", `/forge/${service}/pr`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, ...spec }));
  }

  forgeComment(service: string, ref: RepoRef, issue: number, body: string): Promise<CommentResult> {
    return this.request("POST", `/forge/${service}/comment`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, issue, body }));
  }

  forgeProvision(service: string): Promise<ForgeProvisionResult> {
    return this.request("POST", `/forge/${service}/provision`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/client/src/client.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/client.ts packages/client/src/client.test.ts
git commit -m "feat(client): typed forge methods on the signed client"
```

---

### Task 12: MCP forge tools

**Files:**
- Modify: `packages/mcp/src/tools.ts`
- Modify: `packages/mcp/src/server.ts`
- Test: `packages/mcp/src/tools.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to `packages/mcp/src/tools.test.ts`; reuse the file's existing fake-manager helper if one exists, otherwise use this standalone block)

```ts
import { describe, expect, it, vi } from "vitest";
import type { ClaimManager } from "./claim-manager.js";
import { makeTools } from "./tools.js";

describe("forge tools", () => {
  function managerWith(client: Record<string, unknown>): ClaimManager {
    return { client: () => client } as never;
  }

  it("forge_commit delegates to the client with service defaulting to github", async () => {
    const forgeCommit = vi.fn(async () => ({ sha: "c1", url: "u" }));
    const tools = makeTools(managerWith({ forgeCommit }));
    const result = await tools.forgeCommit({
      owner: "o", repo: "r", branch: "b", message: "m",
      files: [{ path: "f", content: "x" }],
    });
    expect(result).toEqual({ sha: "c1", url: "u" });
    expect(forgeCommit).toHaveBeenCalledWith("github", { owner: "o", name: "r" },
      { branch: "b", message: "m", files: [{ path: "f", content: "x" }] });
  });

  it("forge tools return proxy errors as clean results", async () => {
    const forgeCommit = vi.fn(async () => {
      throw new Error('API 403: {"error":"missing_capability","remediation":"ask the operator"}');
    });
    const tools = makeTools(managerWith({ forgeCommit }));
    const result = await tools.forgeCommit({
      owner: "o", repo: "r", branch: "b", message: "m",
      files: [{ path: "f", content: "x" }],
    });
    expect(result).toEqual({
      error: 'API 403: {"error":"missing_capability","remediation":"ask the operator"}',
    });
  });

  it("forge_open_pr and forge_comment delegate with explicit service", async () => {
    const forgeOpenPr = vi.fn(async () => ({ number: 2, url: "u" }));
    const forgeComment = vi.fn(async () => ({ id: 4, url: "u" }));
    const tools = makeTools(managerWith({ forgeOpenPr, forgeComment }));
    await tools.forgeOpenPr({
      service: "gitlab", owner: "o", repo: "r",
      head: "h", base: "b", title: "t", body: "d",
    });
    await tools.forgeComment({ owner: "o", repo: "r", issue: 4, body: "hi" });
    expect(forgeOpenPr).toHaveBeenCalledWith("gitlab", { owner: "o", name: "r" },
      { head: "h", base: "b", title: "t", body: "d" });
    expect(forgeComment).toHaveBeenCalledWith("github", { owner: "o", name: "r" }, 4, "hi");
  });

  it("forge_provision defaults to gitlab", async () => {
    const forgeProvision = vi.fn(async () => ({ username: "agent-1", email: "1@d" }));
    const tools = makeTools(managerWith({ forgeProvision }));
    const r = await tools.forgeProvision({});
    expect(r).toEqual({ username: "agent-1", email: "1@d" });
    expect(forgeProvision).toHaveBeenCalledWith("gitlab");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/mcp/src/tools.test.ts`
Expected: new tests FAIL (`tools.forgeCommit is not a function`).

- [ ] **Step 3: Add the tool implementations** (in `makeTools`'s returned object in `packages/mcp/src/tools.ts`, after `waitForEmail`)

```ts
    async forgeRepo(args: { service?: string; owner: string; repo: string }) {
      try {
        return await manager.client().forgeRepo(args.service ?? "github",
          { owner: args.owner, name: args.repo });
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    async forgeCommit(args: {
      service?: string; owner: string; repo: string; branch: string;
      message: string; files: { path: string; content: string }[];
    }) {
      try {
        return await manager.client().forgeCommit(args.service ?? "github",
          { owner: args.owner, name: args.repo },
          { branch: args.branch, message: args.message, files: args.files });
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    async forgeOpenPr(args: {
      service?: string; owner: string; repo: string;
      head: string; base: string; title: string; body: string;
    }) {
      try {
        return await manager.client().forgeOpenPr(args.service ?? "github",
          { owner: args.owner, name: args.repo },
          { head: args.head, base: args.base, title: args.title, body: args.body });
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    async forgeComment(args: {
      service?: string; owner: string; repo: string; issue: number; body: string;
    }) {
      try {
        return await manager.client().forgeComment(args.service ?? "github",
          { owner: args.owner, name: args.repo }, args.issue, args.body);
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    async forgeProvision(args: { service?: string }) {
      try {
        return await manager.client().forgeProvision(args.service ?? "gitlab");
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/mcp/src/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the tools in the server** (append to `packages/mcp/src/server.ts` before the transport lines)

```ts
server.registerTool(
  "forge_repo",
  {
    description: "Get a repo's default branch and head sha via the forge proxy (service defaults to github).",
    inputSchema: {
      service: z.string().optional(),
      owner: z.string(),
      repo: z.string(),
    },
  },
  async (args) => json(await tools.forgeRepo(args)),
);

server.registerTool(
  "forge_commit",
  {
    description: "Create a commit on a branch via the forge proxy. Authorship is set server-side to this session's identity; the request carries no author.",
    inputSchema: {
      service: z.string().optional(),
      owner: z.string(),
      repo: z.string(),
      branch: z.string(),
      message: z.string(),
      files: z.array(z.object({ path: z.string(), content: z.string() })),
    },
  },
  async (args) => json(await tools.forgeCommit(args)),
);

server.registerTool(
  "forge_open_pr",
  {
    description: "Open a pull/merge request via the forge proxy. An attribution footer naming this identity is appended.",
    inputSchema: {
      service: z.string().optional(),
      owner: z.string(),
      repo: z.string(),
      head: z.string(),
      base: z.string(),
      title: z.string(),
      body: z.string(),
    },
  },
  async (args) => json(await tools.forgeOpenPr(args)),
);

server.registerTool(
  "forge_comment",
  {
    description: "Comment on an issue via the forge proxy. An attribution footer naming this identity is appended.",
    inputSchema: {
      service: z.string().optional(),
      owner: z.string(),
      repo: z.string(),
      issue: z.number().int(),
      body: z.string(),
    },
  },
  async (args) => json(await tools.forgeComment(args)),
);

server.registerTool(
  "forge_provision",
  {
    description: "Provision this session's identity on a forge that supports it (default gitlab): creates a service account whose email is this identity's mailbox, then watch for the confirmation email with wait_for_email.",
    inputSchema: { service: z.string().optional() },
  },
  async (args) => json(await tools.forgeProvision(args)),
);
```

- [ ] **Step 6: Typecheck and run the mcp package tests**

Run: `npx tsc --noEmit -p tsconfig.base.json && pnpm vitest run packages/mcp`
Expected: clean, all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/tools.ts packages/mcp/src/tools.test.ts packages/mcp/src/server.ts
git commit -m "feat(mcp): forge_repo/forge_commit/forge_open_pr/forge_comment/forge_provision tools"
```

---

### Task 13: Skill doc + deploy summary

**Files:**
- Modify: `packages/dist/skill/SKILL.md`
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Document the tools in the bundled skill**

Append to `packages/dist/skill/SKILL.md`:

```markdown
## Forge operations (via the access proxy)

If this deployment runs the forge proxy and your identity has the service
capability (`github` or `gitlab`), five more tools work: `forge_repo`
(default branch + head sha), `forge_commit` (create a commit — authorship
is set server-side to YOUR identity; you cannot and need not supply an
author), `forge_open_pr`, `forge_comment` (both append an attribution
footer naming your identity), and `forge_provision`. `service` defaults
to `"github"` (`forge_provision` defaults to `"gitlab"`). A
`missing_capability` error means this identity is not onboarded — relay
the remediation text to the human. A `not_provisioned` error on gitlab
means: call `forge_provision`, then `wait_for_email` for the GitLab
confirmation mail and follow its link. Force-push and branch deletion do
not exist in this surface.
```

- [ ] **Step 2: Add the setup steps to the deploy job summary**

In `.github/workflows/deploy.yml`, the "Write job summary" step ends its heredoc with a numbered manual-steps list. Add after the fleet-key line (`3. Mint a fleet key: ...`):

```
          4. Store the shared GitHub PAT (proxy): \`aws ssm put-parameter --name /agent-identity/forge/github/pat --type SecureString --value <fine-grained-PAT>\`
          5. For GitLab provisioning: \`aws ssm put-parameter --name /agent-identity/forge/gitlab/admin-token --type SecureString --value <group-owner-token>\` and \`aws ssm put-parameter --name /agent-identity/forge/gitlab/group --type String --value <top-level-group-id>\`
```

- [ ] **Step 3: Commit**

```bash
git add packages/dist/skill/SKILL.md .github/workflows/deploy.yml
git commit -m "docs: forge tools in bundled skill; proxy setup in deploy summary"
```

---

### Task 14: Phase 1 verification + PR 1

- [ ] **Step 1: Run everything CI runs**

```bash
pnpm vitest run
npx tsc --noEmit -p tsconfig.base.json
cd infra && pnpm exec cdk synth -c domain=ci.invalid > /dev/null; echo "synth: $?"; cd ..
```

Expected: all tests pass, tsc clean, synth exit 0.

- [ ] **Step 2: Fix anything red, re-run until green.**

- [ ] **Step 3: Push and open PR 1**

```bash
git push origin feat/forge-access-proxy
gh pr create -R critical-labs/agent-identity --base main --head feat/forge-access-proxy \
  --title "feat: forge access proxy — central credential custody, typed GitHub ops (#22)" \
  --body "Implements the #22 MVP per docs/superpowers/specs/2026-08-20-forge-access-proxy-design.md: /forge/{service}/* proxy Lambda with ports+adapters (GithubForge + FakeForge), actor on every port call, forced commit authorship, capability-gated access, per-identity-first SSM credential resolution, allow-all policy seam for #23, client forge methods and MCP forge_* tools. GitLab adapter + provisioning follow in PR 2."
```

Expected: PR CI (test job) green.

---

## Phase 2 — GitLab adapter + per-identity provisioning (PR 2)

Branch from updated main after PR 1 merges: `git checkout main && git pull --ff-only origin main && git checkout -b feat/forge-gitlab`.

### Task 15: GitLab adapter

**Files:**
- Create: `packages/proxy/src/gitlab.ts`
- Test: `packages/proxy/src/gitlab.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/proxy/src/gitlab.test.ts` (reuses the same `makeFetch` shape as `github.test.ts`):

```ts
import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "./forge.js";
import { GitlabForge } from "./gitlab.js";

const credentials: CredentialStore = { resolve: async () => "glpat-x" };
const actor = { name: "482913", email: "482913@agents.example" };

function makeFetch(routes: Record<string, { status?: number; json?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200 });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const P = "https://gitlab.com/api/v4/projects/o%2Fr";

describe("GitlabForge.getRepo", () => {
  it("returns default branch and head sha, using PRIVATE-TOKEN auth", async () => {
    const resolve = vi.fn(async () => "glpat-x");
    const { fn, calls } = makeFetch({
      [`GET ${P}`]: { json: { default_branch: "main" } },
      [`GET ${P}/repository/branches/main`]: { json: { commit: { id: "abc123" } } },
    });
    const forge = new GitlabForge({ credentials: { resolve }, fetch: fn });
    const info = await forge.getRepo({ owner: "o", name: "r" }, actor);
    expect(info).toEqual({ defaultBranch: "main", headSha: "abc123" });
    expect(resolve).toHaveBeenCalledWith("gitlab", "482913");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("PRIVATE-TOKEN")).toBe("glpat-x");
  });
});

describe("GitlabForge.createCommit", () => {
  it("probes file existence to choose create vs update and forces the author", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${P}/repository/files/exists.txt?ref=main`]: { json: { file_path: "exists.txt" } },
      [`GET ${P}/repository/files/new.txt?ref=main`]: { status: 404, json: { message: "404" } },
      [`POST ${P}/repository/commits`]: {
        json: { id: "sha1", web_url: "https://gitlab.com/o/r/-/commit/sha1" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, {
      branch: "main", message: "m",
      files: [{ path: "exists.txt", content: "A" }, { path: "new.txt", content: "B" }],
    }, actor);
    expect(result).toEqual({ sha: "sha1", url: "https://gitlab.com/o/r/-/commit/sha1" });
    const commitCall = calls.find((c) => c.url === `${P}/repository/commits`)!;
    expect(JSON.parse(commitCall.init.body as string)).toEqual({
      branch: "main", commit_message: "m",
      author_name: "482913", author_email: "482913@agents.example",
      actions: [
        { action: "update", file_path: "exists.txt", content: "A" },
        { action: "create", file_path: "new.txt", content: "B" },
      ],
    });
  });
});

describe("GitlabForge.openPullRequest and comment", () => {
  it("opens an MR (iid becomes number)", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${P}/merge_requests`]: {
        json: { iid: 4, web_url: "https://gitlab.com/o/r/-/merge_requests/4" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const pr = await forge.openPullRequest({ owner: "o", name: "r" },
      { head: "feat/x", base: "main", title: "t", body: "d" }, actor);
    expect(pr).toEqual({ number: 4, url: "https://gitlab.com/o/r/-/merge_requests/4" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      source_branch: "feat/x", target_branch: "main", title: "t", description: "d",
    });
  });

  it("comments as an issue note with a constructed url", async () => {
    const { fn } = makeFetch({
      [`POST ${P}/issues/12/notes`]: { json: { id: 55 } },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const c = await forge.comment({ owner: "o", name: "r" }, 12, "hi", actor);
    expect(c).toEqual({ id: 55, url: "https://gitlab.com/o/r/-/issues/12#note_55" });
  });

  it("maps 401 to upstream_auth", async () => {
    const { fn } = makeFetch({ [`GET ${P}`]: { status: 401, json: { message: "401" } } });
    const forge = new GitlabForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "upstream_auth" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/gitlab.test.ts`
Expected: FAIL — cannot resolve `./gitlab.js`.

- [ ] **Step 3: Write the adapter**

`packages/proxy/src/gitlab.ts`:

```ts
import type {
  CommentResult, CommitResult, CommitSpec, PrResult, PrSpec, RepoInfo, RepoRef,
} from "@agent-identity/shared";
import {
  ForgeError, type Author, type CredentialStore, type Forge,
} from "./forge.js";

export interface GitlabForgeOptions {
  credentials: CredentialStore;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;   // default https://gitlab.com/api/v4
  webBase?: string;   // default https://gitlab.com
}

export class GitlabForge implements Forge {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly base: string;
  private readonly web: string;

  constructor(private readonly opts: GitlabForgeOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.base = opts.apiBase ?? "https://gitlab.com/api/v4";
    this.web = opts.webBase ?? "https://gitlab.com";
  }

  private project(ref: RepoRef): string {
    return encodeURIComponent(`${ref.owner}/${ref.name}`);
  }

  private async gl<T>(method: string, path: string, agentId: string, body?: unknown): Promise<T> {
    const token = await this.opts.credentials.resolve("gitlab", agentId);
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await this.mapError(res);
    return res.json() as Promise<T>;
  }

  private async mapError(res: Response): Promise<ForgeError> {
    const text = await res.text();
    if (res.status === 401) return new ForgeError("upstream_auth", "gitlab rejected the credential", 401);
    if (res.status === 404) return new ForgeError("not_found", "not found on gitlab", 404);
    if (res.status === 429) return new ForgeError("rate_limited", "gitlab rate limit", 429);
    return new ForgeError("invalid", `gitlab ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  private async fileExists(project: string, filePath: string, branch: string, agentId: string): Promise<boolean> {
    try {
      await this.gl("GET",
        `/projects/${project}/repository/files/${encodeURIComponent(filePath)}?ref=${branch}`,
        agentId);
      return true;
    } catch (err) {
      if (err instanceof ForgeError && err.kind === "not_found") return false;
      throw err;
    }
  }

  async getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo> {
    const p = this.project(ref);
    const proj = await this.gl<{ default_branch: string }>("GET", `/projects/${p}`, actor.name);
    const branch = await this.gl<{ commit: { id: string } }>(
      "GET", `/projects/${p}/repository/branches/${proj.default_branch}`, actor.name);
    return { defaultBranch: proj.default_branch, headSha: branch.commit.id };
  }

  async createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult> {
    const p = this.project(ref);
    const actions = [];
    for (const f of spec.files) {
      const exists = await this.fileExists(p, f.path, spec.branch, actor.name);
      actions.push({ action: exists ? "update" : "create", file_path: f.path, content: f.content });
    }
    const commit = await this.gl<{ id: string; web_url: string }>(
      "POST", `/projects/${p}/repository/commits`, actor.name, {
        branch: spec.branch, commit_message: spec.message,
        author_name: actor.name, author_email: actor.email,
        actions,
      });
    return { sha: commit.id, url: commit.web_url };
  }

  async openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult> {
    const mr = await this.gl<{ iid: number; web_url: string }>(
      "POST", `/projects/${this.project(ref)}/merge_requests`, actor.name, {
        source_branch: spec.head, target_branch: spec.base,
        title: spec.title, description: spec.body,
      });
    return { number: mr.iid, url: mr.web_url };
  }

  async comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult> {
    const note = await this.gl<{ id: number }>(
      "POST", `/projects/${this.project(ref)}/issues/${issue}/notes`, actor.name, { body });
    return {
      id: note.id,
      url: `${this.web}/${ref.owner}/${ref.name}/-/issues/${issue}#note_${note.id}`,
    };
  }
}
```

Note: `encodeURIComponent("exists.txt")` leaves dots intact, which is why the test routing keys use plain `exists.txt` — the implementation must use plain `encodeURIComponent` for file paths.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/proxy/src/gitlab.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/gitlab.ts packages/proxy/src/gitlab.test.ts
git commit -m "feat(proxy): gitlab adapter — per-identity credentials, single-call commits"
```

---

### Task 16: GitLab provisioner

**Files:**
- Create: `packages/proxy/src/gitlab-provision.ts`
- Test: `packages/proxy/src/gitlab-provision.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/proxy/src/gitlab-provision.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { GitlabProvisioner } from "./gitlab-provision.js";

const actor = { name: "482913", email: "482913@agents.example" };
const G = "https://gitlab.com/api/v4/groups/42";

function makeFetch(routes: Record<string, { status?: number; json?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200 });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

function makeDeps(fetchFn: typeof globalThis.fetch) {
  const put = vi.fn(async () => {});
  const provisioner = new GitlabProvisioner({
    config: { adminToken: async () => "owner-tok", groupId: async () => "42" },
    sink: { put },
    fetch: fetchFn,
    now: () => Date.parse("2026-08-21T00:00:00Z"),
  });
  return { provisioner, put };
}

describe("GitlabProvisioner", () => {
  it("creates account, adds membership, mints PAT, stores it", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${G}/service_accounts`]: { json: [] },
      [`POST ${G}/service_accounts`]: {
        json: { id: 777, username: "agent-482913", email: "482913@agents.example" },
      },
      [`POST ${G}/members`]: { json: {} },
      [`POST ${G}/service_accounts/777/personal_access_tokens`]: {
        json: { token: "glpat-new" },
      },
    });
    const { provisioner, put } = makeDeps(fn);
    const result = await provisioner.provision(actor);
    expect(result).toEqual({ username: "agent-482913", email: "482913@agents.example" });
    expect(put).toHaveBeenCalledWith("gitlab", "482913", "glpat-new");

    const create = calls.find((c) => c.url === `${G}/service_accounts` && c.init.method === "POST")!;
    expect(JSON.parse(create.init.body as string)).toEqual({
      name: "agent 482913", username: "agent-482913", email: "482913@agents.example",
    });
    const member = calls.find((c) => c.url === `${G}/members`)!;
    expect(JSON.parse(member.init.body as string)).toEqual({ user_id: 777, access_level: 30 });
    const pat = calls.find((c) => c.url.endsWith("/personal_access_tokens"))!;
    expect(JSON.parse(pat.init.body as string)).toEqual({
      name: "agent-identity-proxy", scopes: ["api"], expires_at: "2027-08-21",
    });
    const h = new Headers(create.init.headers);
    expect(h.get("PRIVATE-TOKEN")).toBe("owner-tok");
  });

  it("is idempotent: reuses an existing account and tolerates existing membership", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${G}/service_accounts`]: {
        json: [{ id: 777, username: "agent-482913", email: "482913@agents.example" }],
      },
      [`POST ${G}/members`]: { status: 409, json: { message: "Member already exists" } },
      [`POST ${G}/service_accounts/777/personal_access_tokens`]: { json: { token: "glpat-2" } },
    });
    const { provisioner, put } = makeDeps(fn);
    const result = await provisioner.provision(actor);
    expect(result.username).toBe("agent-482913");
    expect(put).toHaveBeenCalledWith("gitlab", "482913", "glpat-2");
    expect(calls.some((c) => c.url === `${G}/service_accounts` && c.init.method === "POST")).toBe(false);
  });

  it("surfaces owner-token rejection as upstream_auth", async () => {
    const { fn } = makeFetch({
      [`GET ${G}/service_accounts`]: { status: 401, json: { message: "401" } },
    });
    const { provisioner } = makeDeps(fn);
    await expect(provisioner.provision(actor)).rejects.toMatchObject({ kind: "upstream_auth" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/gitlab-provision.test.ts`
Expected: FAIL — cannot resolve `./gitlab-provision.js`.

- [ ] **Step 3: Write the provisioner**

`packages/proxy/src/gitlab-provision.ts`:

```ts
import type { ForgeProvisionResult } from "@agent-identity/shared";
import { ForgeError, type Author, type Provisioner } from "./forge.js";

export interface ProvisionerConfig {
  adminToken(): Promise<string>;
  groupId(): Promise<string>;
}

export interface TokenSink {
  put(service: string, agentId: string, token: string): Promise<void>;
}

export interface GitlabProvisionerOptions {
  config: ProvisionerConfig;
  sink: TokenSink;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  now?: () => number;
}

interface ServiceAccount {
  id: number;
  username: string;
  email: string;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export class GitlabProvisioner implements Provisioner {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly base: string;
  private readonly now: () => number;

  constructor(private readonly opts: GitlabProvisionerOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.base = opts.apiBase ?? "https://gitlab.com/api/v4";
    this.now = opts.now ?? Date.now;
  }

  private async gl<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) throw new ForgeError("upstream_auth", "gitlab rejected the admin token", 401);
      throw new ForgeError("invalid", `gitlab ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    return res.json() as Promise<T>;
  }

  async provision(actor: Author): Promise<ForgeProvisionResult> {
    const token = await this.opts.config.adminToken();
    const gid = await this.opts.config.groupId();
    const username = `agent-${actor.name}`;

    const accounts = await this.gl<ServiceAccount[]>(token, "GET", `/groups/${gid}/service_accounts`);
    let acct = accounts.find((a) => a.username === username);
    if (!acct) {
      acct = await this.gl<ServiceAccount>(token, "POST", `/groups/${gid}/service_accounts`, {
        name: `agent ${actor.name}`, username, email: actor.email,
      });
    }

    try {
      await this.gl(token, "POST", `/groups/${gid}/members`, {
        user_id: acct.id, access_level: 30,
      });
    } catch (err) {
      if (!(err instanceof ForgeError && /member/i.test(err.message))) throw err;
    }

    const expires = new Date(this.now() + YEAR_MS).toISOString().slice(0, 10);
    const pat = await this.gl<{ token: string }>(token, "POST",
      `/groups/${gid}/service_accounts/${acct.id}/personal_access_tokens`, {
        name: "agent-identity-proxy", scopes: ["api"], expires_at: expires,
      });
    await this.opts.sink.put("gitlab", actor.name, pat.token);

    return { username: acct.username, email: acct.email };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/proxy/src/gitlab-provision.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/gitlab-provision.ts packages/proxy/src/gitlab-provision.test.ts
git commit -m "feat(proxy): gitlab service-account provisioner — idempotent, mailbox email"
```

---

### Task 17: Provision route

**Files:**
- Modify: `packages/proxy/src/app.ts`
- Test: `packages/proxy/src/app.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `app.test.ts`)

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/proxy/src/app.test.ts`
Expected: the two new tests FAIL (404 unknown route ≠ expected shapes — verify the failure is on assertions, not compile errors).

- [ ] **Step 3: Add the route** (inside `createProxyApp`, after the comment route)

```ts
  app.post("/forge/:service/provision", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const provisioner = deps.provisioners?.[g.service];
    if (!provisioner) return c.json({ error: "provisioning_unsupported" }, 404);
    const op: ForgeOp = { service: g.service, kind: "provision", owner: "-", repo: "-" };
    return run(c, g, op, () => provisioner.provision(g.actor));
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/proxy/src/app.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/app.ts packages/proxy/src/app.test.ts
git commit -m "feat(proxy): capability-gated provision route"
```

---

### Task 18: Wiring + infra for GitLab

**Files:**
- Modify: `packages/proxy/src/lambda.ts`
- Modify: `infra/lib/stack.ts`

- [ ] **Step 1: Wire the adapter and provisioner**

Replace the `forges` wiring in `packages/proxy/src/lambda.ts`:

```ts
import { GitlabForge } from "./gitlab.js";
import { GitlabProvisioner } from "./gitlab-provision.js";
```

and change the `createProxyApp` call to:

```ts
const app = createProxyApp({
  agents: new AgentsRepo(ddb, table, domain),
  nonces: new NoncesRepo(ddb, table),
  forges: {
    github: new GithubForge({ credentials }),
    gitlab: new GitlabForge({ credentials }),
  },
  provisioners: {
    gitlab: new GitlabProvisioner({
      config: {
        adminToken: () => credentials.getParam("/agent-identity/forge/gitlab/admin-token"),
        groupId: () => credentials.getParam("/agent-identity/forge/gitlab/group"),
      },
      sink: credentials,
    }),
  },
});
```

- [ ] **Step 2: Grant PutParameter on the per-identity PAT prefix**

In `infra/lib/stack.ts`, after the existing `ssm:GetParameter` policy statement on the proxy function, add:

```ts
    proxyFn.addToRolePolicy(new PolicyStatement({
      actions: ["ssm:PutParameter"],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/agent-identity/forge/gitlab/pat/*`,
      ],
    }));
```

- [ ] **Step 3: Typecheck and synth**

Run: `npx tsc --noEmit -p tsconfig.base.json`
Expected: clean.

Run: `cd infra && pnpm exec cdk synth -c domain=ci.invalid > /dev/null; echo "exit: $?"; cd ..`
Expected: `exit: 0`.

- [ ] **Step 4: Commit**

```bash
git add packages/proxy/src/lambda.ts infra/lib/stack.ts
git commit -m "feat(infra): wire gitlab adapter and provisioner; scoped PutParameter grant"
```

---

### Task 19: Phase 2 verification + PR 2

- [ ] **Step 1: Run everything CI runs**

```bash
pnpm vitest run
npx tsc --noEmit -p tsconfig.base.json
cd infra && pnpm exec cdk synth -c domain=ci.invalid > /dev/null; echo "synth: $?"; cd ..
```

Expected: all green.

- [ ] **Step 2: Push and open PR 2**

```bash
git push origin feat/forge-gitlab
gh pr create -R critical-labs/agent-identity --base main --head feat/forge-gitlab \
  --title "feat: gitlab adapter + per-identity service-account provisioning" \
  --body "Second adapter for the forge proxy per the amended spec: GitlabForge (per-identity PATs, single-call commits with forced author, MR + issue-note ops) and GitlabProvisioner (idempotent group service accounts whose email is the agent's own mailbox; PAT minted and stored at the identity's SSM path). Provision route is capability-gated; forge_provision MCP tool included in PR 1."
```

Expected: PR CI green.

---

### Task 20: Post-merge operator steps (documentation of manual work, not code)

1. GitHub: mint a fine-grained PAT on the backing account; `aws ssm put-parameter --name /agent-identity/forge/github/pat --type SecureString --value <PAT>`.
2. GitLab: create a top-level group; mint a group Owner token; store `/agent-identity/forge/gitlab/admin-token` (SecureString) and `/agent-identity/forge/gitlab/group` (String).
3. Approve the production deploys.
4. Tag identities: `mailctl agent tag <id> github` and/or `<id> gitlab`.
5. Agent self-onboarding on GitLab: `forge_provision` → `wait_for_email` (GitLab confirmation) → follow link → `forge_repo` smoke test.
