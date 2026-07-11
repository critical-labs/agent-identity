# Session Identity Claiming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A machine-local identity pool where each MCP server process atomically claims one profile for its lifetime, preferring reuse over creation, with GitHub-capability filtering.

**Architecture:** New pure claim library in `packages/client` (lockfile claims with PID-liveness); a `ClaimManager` in `packages/mcp` that claims at startup, swaps on demand, and releases on exit; server-side `capabilities` tag readable via `/me` and settable via mailctl. Spec: `docs/superpowers/specs/2026-07-10-session-identity-claiming-design.md`.

**Tech Stack:** TypeScript ESM, Node 20 (`node:fs` sync APIs), vitest (run from repo root: `pnpm test`), commander (CLI), pnpm workspace.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/client/src/claims.ts` (new) | Pool scan, capability filter, atomic claim/release, stale takeover, pool status, github link. Pure, filesystem-only. |
| `packages/client/src/claims.test.ts` (new) | Unit tests for the above (tmp dirs, injected `isAlive`). |
| `packages/client/src/cli.ts` (new) | `agent-identity` bin: `github link` command. Thin commander wiring over `linkGithub`. |
| `packages/client/src/index.ts` | Re-export claims module. |
| `packages/client/package.json` | Add `bin` + `commander` dependency. |
| `packages/mcp/src/claim-manager.ts` (new) | Holds the claim: init/claim, auto-create plain, swap, status, release. Owns the API client for the claimed keypair. |
| `packages/mcp/src/claim-manager.test.ts` (new) | Unit tests with fake client factory. |
| `packages/mcp/src/tools.ts` | Tools call through the manager; `ensureIdentity` gains `require`; add `identityStatus`. |
| `packages/mcp/src/tools.test.ts` | Update for manager-based tools. |
| `packages/mcp/src/server.ts` | Construct manager, exit handlers, register `identity_status`, `require` input on `ensure_identity`. |
| `packages/api/src/db/agents.ts` | `capabilities?: string[]` on `AgentRecord`. |
| `packages/api/src/app.ts` + `app.test.ts` | `/me` returns `capabilities`. |
| `packages/admin/src/commands.ts` + `commands.test.ts` (new) | `tagAgent`/`untagAgent`; `listAgents` shows capabilities. |
| `packages/admin/src/mailctl.ts` | `agent tag|untag <agentId> <capability>` commands. |
| `README.md` | Pool/claiming docs, `AGENT_IDENTITY_REQUIRE`, GitHub onboarding checklist, optional SessionStart hook. |

Conventions: tests are colocated `*.test.ts`, run with `pnpm test` (root vitest, all packages). All commits are signed automatically by repo config — never pass `--no-gpg-sign`. Work happens in the `feat/session-identity-claiming` worktree.

---

### Task 1: Pool primitives — list, filter, save, link

**Files:**
- Create: `packages/client/src/claims.ts`
- Create: `packages/client/src/claims.test.ts`
- Modify: `packages/client/src/index.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/client/src/claims.test.ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasCapabilities, linkGithub, listPool, poolDir, savePoolProfile,
  type PoolProfile,
} from "./claims.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-claims-"));

const profile = (agentId: string, github?: { username: string }): PoolProfile & { agentId: string } => ({
  publicKeySpkiBase64: `pk-${agentId}`,
  privateKeyPem: `sk-${agentId}`,
  agentId,
  address: `${agentId}@d`,
  ...(github ? { github } : {}),
});

describe("pool primitives", () => {
  it("listPool returns [] when pool dir does not exist", () => {
    expect(listPool(base())).toEqual([]);
  });

  it("savePoolProfile names the file by agentId and listPool reads it back", () => {
    const dir = base();
    const name = savePoolProfile(profile("111111"), dir);
    expect(name).toBe("111111");
    const pool = listPool(dir);
    expect(pool).toHaveLength(1);
    expect(pool[0].name).toBe("111111");
    expect(pool[0].profile.address).toBe("111111@d");
  });

  it("listPool skips corrupt profile files", () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    writeFileSync(join(poolDir(dir), "bad.json"), "{nope");
    expect(listPool(dir).map((p) => p.name)).toEqual(["111111"]);
  });

  it("hasCapabilities: github requires a github block; unknown caps never match", () => {
    expect(hasCapabilities(profile("1"), [])).toBe(true);
    expect(hasCapabilities(profile("1"), ["github"])).toBe(false);
    expect(hasCapabilities(profile("1", { username: "x" }), ["github"])).toBe(true);
    expect(hasCapabilities(profile("1", { username: "x" }), ["gitlab"])).toBe(false);
  });

  it("linkGithub writes the github block into an existing pool profile", () => {
    const dir = base();
    savePoolProfile(profile("222222"), dir);
    linkGithub("222222", { username: "critical-agent-two", credentialRef: "op://x" }, dir);
    const saved = JSON.parse(readFileSync(join(poolDir(dir), "222222.json"), "utf8"));
    expect(saved.github).toEqual({ username: "critical-agent-two", credentialRef: "op://x" });
  });

  it("linkGithub throws a clear error for a missing profile", () => {
    expect(() => linkGithub("999999", { username: "x" }, base()))
      .toThrow(/no pool profile named 999999/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- claims`
Expected: FAIL — `claims.js` module not found.

- [ ] **Step 3: Implement**

```ts
// packages/client/src/claims.ts
import type { Keypair } from "@agent-identity/shared";
import {
  mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { defaultProfileDir } from "./profile.js";

export interface GithubLink {
  username: string;
  credentialRef?: string; // reference (e.g. op://...), never a plaintext credential
}

export interface PoolProfile extends Keypair {
  agentId?: string;
  address?: string;
  github?: GithubLink;
}

export const poolDir = (base: string = defaultProfileDir()): string => join(base, "pool");
export const claimsDir = (base: string = defaultProfileDir()): string => join(base, "claims");

export function listPool(base?: string): Array<{ name: string; profile: PoolProfile }> {
  let files: string[];
  try {
    files = readdirSync(poolDir(base)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Array<{ name: string; profile: PoolProfile }> = [];
  for (const f of files.sort()) {
    try {
      out.push({
        name: f.slice(0, -".json".length),
        profile: JSON.parse(readFileSync(join(poolDir(base), f), "utf8")) as PoolProfile,
      });
    } catch {
      console.warn(`agent-identity: skipping corrupt pool profile ${f}`);
    }
  }
  return out;
}

export function hasCapabilities(profile: PoolProfile, require: string[]): boolean {
  return require.every((cap) => (cap === "github" ? profile.github !== undefined : false));
}

export function savePoolProfile(
  profile: PoolProfile & { agentId: string }, base?: string,
): string {
  mkdirSync(poolDir(base), { recursive: true });
  writeFileSync(
    join(poolDir(base), `${profile.agentId}.json`),
    JSON.stringify(profile, null, 2),
    { mode: 0o600 },
  );
  return profile.agentId;
}

export function linkGithub(agentId: string, link: GithubLink, base?: string): void {
  const file = join(poolDir(base), `${agentId}.json`);
  let profile: PoolProfile;
  try {
    profile = JSON.parse(readFileSync(file, "utf8")) as PoolProfile;
  } catch {
    throw new Error(`no pool profile named ${agentId} in ${poolDir(base)}`);
  }
  writeFileSync(file, JSON.stringify({ ...profile, github: link }, null, 2), { mode: 0o600 });
}
```

(`unlinkSync`/`hostname` are imported now because Task 2 uses them; if your linter flags them as unused, add them in Task 2 instead.)

Append to `packages/client/src/index.ts`:

```ts
export * from "./claims.js";
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test -- claims`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/claims.ts packages/client/src/claims.test.ts packages/client/src/index.ts
git commit -m "feat(client): identity pool primitives — list, filter, save, github link"
```

---

### Task 2: Atomic claim / release

**Files:**
- Modify: `packages/client/src/claims.ts`
- Modify: `packages/client/src/claims.test.ts`

- [ ] **Step 1: Write failing tests** (append to `claims.test.ts`; add `claimFromPool, claimSpecific` to the existing import from `./claims.js`)

```ts
import { claimFromPool, claimSpecific } from "./claims.js";

describe("claiming", () => {
  it("claims the lexicographically first free matching profile", async () => {
    const dir = base();
    savePoolProfile(profile("222222"), dir);
    savePoolProfile(profile("111111"), dir);
    const claim = await claimFromPool({ base: dir });
    expect(claim?.name).toBe("111111");
  });

  it("two claims from the same pool get different profiles", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222"), dir);
    const a = await claimFromPool({ base: dir });
    const b = await claimFromPool({ base: dir });
    expect(a?.name).toBe("111111");
    expect(b?.name).toBe("222222");
  });

  it("returns undefined when everything is claimed by live pids", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    await claimFromPool({ base: dir });
    expect(await claimFromPool({ base: dir })).toBeUndefined();
  });

  it("release makes the profile claimable again", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const a = await claimFromPool({ base: dir });
    a!.release();
    expect((await claimFromPool({ base: dir }))?.name).toBe("111111");
  });

  it("respects capability requirements", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222", { username: "x" }), dir);
    const claim = await claimFromPool({ base: dir, require: ["github"] });
    expect(claim?.name).toBe("222222");
  });

  it("excludes named profiles (used by swap)", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const claim = await claimFromPool({ base: dir, exclude: ["111111"] });
    expect(claim).toBeUndefined();
  });

  it("claimSpecific claims exactly the named profile", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222"), dir);
    const claim = await claimSpecific("222222", { base: dir });
    expect(claim?.name).toBe("222222");
    expect(await claimSpecific("222222", { base: dir })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- claims`
Expected: FAIL — `claimFromPool` not exported.

- [ ] **Step 3: Implement** (append to `claims.ts`)

```ts
export interface Claim {
  name: string;
  profile: PoolProfile;
  release(): void;
}

export interface ClaimOptions {
  base?: string;
  require?: string[];
  exclude?: string[];
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; anything else (ESRCH) = dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function tryLock(
  base: string | undefined, name: string, pid: number, isAlive: (pid: number) => boolean,
): Promise<boolean> {
  mkdirSync(claimsDir(base), { recursive: true });
  const lockPath = join(claimsDir(base), `${name}.lock`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid, claimedAt: new Date().toISOString(), host: hostname() }),
        { flag: "wx", mode: 0o600 },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: number | undefined;
      try {
        holder = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }).pid;
      } catch {
        // unreadable/corrupt lock counts as stale
      }
      if (holder !== undefined && isAlive(holder)) return false;
      try {
        unlinkSync(lockPath);
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code !== "ENOENT") throw err2;
      }
      await sleep(Math.random() * 25); // jitter between takeover attempts
    }
  }
  return false;
}

function makeClaim(base: string | undefined, name: string, profile: PoolProfile): Claim {
  return {
    name,
    profile,
    release: () => {
      try {
        unlinkSync(join(claimsDir(base), `${name}.lock`));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}

export async function claimFromPool(opts: ClaimOptions = {}): Promise<Claim | undefined> {
  const { base, require = [], exclude = [], pid = process.pid, isAlive = defaultIsAlive } = opts;
  for (const { name, profile } of listPool(base)) {
    if (exclude.includes(name) || !hasCapabilities(profile, require)) continue;
    if (await tryLock(base, name, pid, isAlive)) return makeClaim(base, name, profile);
  }
  return undefined;
}

export async function claimSpecific(
  name: string, opts: ClaimOptions = {},
): Promise<Claim | undefined> {
  const { base, pid = process.pid, isAlive = defaultIsAlive } = opts;
  const entry = listPool(base).find((p) => p.name === name);
  if (!entry) return undefined;
  if (await tryLock(base, name, pid, isAlive)) return makeClaim(base, name, entry.profile);
  return undefined;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test -- claims`
Expected: 13 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/claims.ts packages/client/src/claims.test.ts
git commit -m "feat(client): atomic lockfile claims with release"
```

---

### Task 3: Stale takeover + pool status

**Files:**
- Modify: `packages/client/src/claims.ts`
- Modify: `packages/client/src/claims.test.ts`

- [ ] **Step 1: Write failing tests** (append; add `claimsDir, poolStatus` to imports from `./claims.js`)

```ts
import { claimsDir, poolStatus } from "./claims.js";

describe("stale locks and status", () => {
  const deadLock = (dir: string, name: string) => {
    mkdirSync(claimsDir(dir), { recursive: true });
    writeFileSync(
      join(claimsDir(dir), `${name}.lock`),
      JSON.stringify({ pid: 99999999, claimedAt: "t", host: "h" }),
    );
  };

  it("takes over a lock whose pid is dead", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    deadLock(dir, "111111");
    const claim = await claimFromPool({ base: dir, isAlive: () => false });
    expect(claim?.name).toBe("111111");
  });

  it("does not take over a lock whose pid is alive", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    deadLock(dir, "111111");
    expect(await claimFromPool({ base: dir, isAlive: () => true })).toBeUndefined();
  });

  it("treats a corrupt lock file as stale", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    mkdirSync(claimsDir(dir), { recursive: true });
    writeFileSync(join(claimsDir(dir), "111111.lock"), "{nope");
    const claim = await claimFromPool({ base: dir, isAlive: () => true });
    expect(claim?.name).toBe("111111");
  });

  it("poolStatus counts free/claimed and by capability", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222", { username: "x" }), dir);
    savePoolProfile(profile("333333", { username: "y" }), dir);
    await claimSpecific("222222", { base: dir });
    const status = poolStatus({ base: dir });
    expect(status).toEqual({
      total: 3,
      free: 2,
      freeByCapability: { github: 1 },
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- claims`
Expected: FAIL — `poolStatus` not exported (the two takeover tests pass already; that's fine — they pin Task 2 behavior).

- [ ] **Step 3: Implement** (append to `claims.ts`)

```ts
export interface PoolStatus {
  total: number;
  free: number;
  freeByCapability: Record<string, number>;
}

function isFree(base: string | undefined, name: string, isAlive: (pid: number) => boolean): boolean {
  try {
    const lock = JSON.parse(
      readFileSync(join(claimsDir(base), `${name}.lock`), "utf8"),
    ) as { pid?: number };
    return lock.pid === undefined || !isAlive(lock.pid);
  } catch {
    return true; // no lock (or unreadable = stale) = free
  }
}

export function poolStatus(
  opts: { base?: string; isAlive?: (pid: number) => boolean } = {},
): PoolStatus {
  const { base, isAlive = defaultIsAlive } = opts;
  const pool = listPool(base);
  const freeProfiles = pool.filter((p) => isFree(base, p.name, isAlive));
  const freeByCapability: Record<string, number> = {};
  const githubFree = freeProfiles.filter((p) => p.profile.github !== undefined).length;
  if (githubFree > 0) freeByCapability.github = githubFree;
  return { total: pool.length, free: freeProfiles.length, freeByCapability };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test -- claims`
Expected: 17 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/claims.ts packages/client/src/claims.test.ts
git commit -m "feat(client): stale-lock takeover and pool status"
```

---

### Task 4: `agent-identity` CLI — `github link`

**Files:**
- Create: `packages/client/src/cli.ts`
- Modify: `packages/client/package.json`

`linkGithub` is already implemented and tested (Task 1); this is thin wiring, tested by hand like `mailctl`.

- [ ] **Step 1: Add bin + dependency**

`packages/client/package.json` becomes:

```json
{
  "name": "@agent-identity/client",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "bin": { "agent-identity": "./src/cli.ts" },
  "dependencies": {
    "@agent-identity/shared": "workspace:*",
    "commander": "^12.0.0"
  }
}
```

Run: `pnpm install`

- [ ] **Step 2: Implement CLI**

```ts
// packages/client/src/cli.ts
#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import { linkGithub } from "./claims.js";

const program = new Command("agent-identity");

program.command("github")
  .command("link <agentId>")
  .description("record that this pool identity has a GitHub account")
  .requiredOption("--username <login>", "GitHub login of the account")
  .option("--credential-ref <ref>", "credential reference (e.g. op://...), never a raw secret")
  .action((agentId: string, opts: { username: string; credentialRef?: string }) => {
    linkGithub(agentId, {
      username: opts.username,
      ...(opts.credentialRef ? { credentialRef: opts.credentialRef } : {}),
    });
    console.log(`linked ${agentId} -> github:${opts.username}`);
  });

await program.parseAsync();
```

(The shebang must be line 1, above the imports — mirror `packages/admin/src/mailctl.ts`.)

- [ ] **Step 3: Smoke-test by hand**

```bash
mkdir -p /tmp/aid-cli-test && AGENT_ID_TEST=1 node -e "
const { savePoolProfile } = require('./packages/client/src/claims.ts');
" 2>/dev/null || true
pnpm exec tsx packages/client/src/cli.ts github link 000000 --username test-login; echo "exit=$?"
```

Expected: exits 1 with `no pool profile named 000000` (proves wiring + error path; a real profile is exercised in Task 5's manager flow).

- [ ] **Step 4: Verify suite still green**

Run: `pnpm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/cli.ts packages/client/package.json pnpm-lock.yaml
git commit -m "feat(client): agent-identity CLI with github link command"
```

---

### Task 5: `ClaimManager` in packages/mcp

**Files:**
- Create: `packages/mcp/src/claim-manager.ts`
- Create: `packages/mcp/src/claim-manager.test.ts`

The manager owns which profile this server process holds and the API client bound to its keypair. Client construction is injected so tests never touch the network.

- [ ] **Step 1: Write failing tests**

```ts
// packages/mcp/src/claim-manager.test.ts
import { savePoolProfile } from "@agent-identity/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaimManager, NoIdentityError } from "./claim-manager.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-mgr-"));

const profile = (agentId: string, github?: { username: string }) => ({
  publicKeySpkiBase64: `pk-${agentId}`,
  privateKeyPem: `sk-${agentId}`,
  agentId,
  address: `${agentId}@d`,
  ...(github ? { github } : {}),
});

// Fake client factory: register() echoes back an identity derived from the keypair.
function fakeFactory(registered: string[] = []) {
  return vi.fn((keypair: { publicKeySpkiBase64: string }) => {
    const id = keypair.publicKeySpkiBase64.startsWith("pk-")
      ? keypair.publicKeySpkiBase64.slice(3)
      : "555555"; // fresh keypair created by auto-create
    return {
      register: vi.fn(async () => {
        registered.push(id);
        return { agentId: id, address: `${id}@d` };
      }),
      listEmails: vi.fn(async () => ({ emails: [] })),
      getEmail: vi.fn(async () => ({ id: "e", from: "f", subject: "s", receivedAt: "t", text: "", links: [] })),
    };
  });
}

describe("ClaimManager", () => {
  it("init claims a free pool profile and client() works", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    expect(mgr.status().held?.name).toBe("111111");
    expect(mgr.client()).toBeDefined();
    mgr.release();
  });

  it("init with empty pool auto-creates, registers, and claims a new profile", async () => {
    const dir = base();
    const registered: string[] = [];
    const mgr = new ClaimManager({
      base: dir, fleetKey: "fk", makeClient: fakeFactory(registered) as never,
    });
    await mgr.init();
    expect(registered).toEqual(["555555"]);
    expect(mgr.status().held?.agentId).toBe("555555");
    expect(mgr.status().pool.total).toBe(1); // saved into the pool
    mgr.release();
  });

  it("init with require github and none free stores the error; tools throw NoIdentityError", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir); // plain only
    const mgr = new ClaimManager({
      base: dir, require: ["github"], makeClient: fakeFactory() as never,
    });
    await mgr.init(); // must not throw
    expect(mgr.status().held).toBeNull();
    expect(() => mgr.client()).toThrow(NoIdentityError);
    await expect(mgr.ensureIdentity()).rejects.toThrow(/no free identity with capabilities \[github\]/);
  });

  it("ensureIdentity registers, persists identity, and is idempotent", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    expect(await mgr.ensureIdentity()).toEqual({ agentId: "111111", address: "111111@d" });
    expect(await mgr.ensureIdentity()).toEqual({ agentId: "111111", address: "111111@d" });
    mgr.release();
  });

  it("ensureIdentity({require:[github]}) swaps to a qualifying profile and frees the old one", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222", { username: "x" }), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    expect(mgr.status().held?.name).toBe("111111");
    expect(await mgr.ensureIdentity(["github"])).toEqual({ agentId: "222222", address: "222222@d" });
    expect(mgr.status().held?.name).toBe("222222");
    expect(mgr.status().pool.freeByCapability).toEqual({}); // github one now held
    // old profile is free again:
    const mgr2 = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr2.init();
    expect(mgr2.status().held?.name).toBe("111111");
    mgr.release();
    mgr2.release();
  });

  it("failed swap keeps the current claim", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    await expect(mgr.ensureIdentity(["github"])).rejects.toThrow(NoIdentityError);
    expect(mgr.status().held?.name).toBe("111111");
    mgr.release();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- claim-manager`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/mcp/src/claim-manager.ts
import {
  AgentIdentityClient, claimFromPool, hasCapabilities, poolStatus,
  savePoolProfile, type Claim, type PoolProfile, type PoolStatus,
} from "@agent-identity/client";
import { generateKeypair, type AgentIdentity, type Keypair } from "@agent-identity/shared";

export class NoIdentityError extends Error {}

export interface AgentClientLike {
  register(): Promise<AgentIdentity>;
  listEmails(opts: { since?: string; limit?: number }): Promise<{ emails: import("@agent-identity/shared").EmailSummary[] }>;
  getEmail(id: string): Promise<import("@agent-identity/shared").EmailFull>;
}

export interface ClaimManagerOptions {
  base?: string;               // pool base dir (default ~/.config/agent-identity)
  apiUrl?: string;
  fleetKey?: string;
  require?: string[];          // from AGENT_IDENTITY_REQUIRE
  makeClient?: (keypair: Keypair) => AgentClientLike;
}

export interface IdentityStatus {
  held: { name: string; agentId?: string; address?: string; capabilities: string[] } | null;
  initError?: string;
  pool: PoolStatus;
}

const capsOf = (p: PoolProfile): string[] => (p.github ? ["github"] : []);

export class ClaimManager {
  private held?: { claim: Claim; client: AgentClientLike };
  private initError?: string;
  private readonly makeClientFn: (keypair: Keypair) => AgentClientLike;

  constructor(private readonly opts: ClaimManagerOptions) {
    this.makeClientFn = opts.makeClient
      ?? ((keypair) => new AgentIdentityClient({
        apiUrl: opts.apiUrl!, keypair, fleetKey: opts.fleetKey,
      }));
  }

  async init(): Promise<void> {
    try {
      await this.claim(this.opts.require ?? []);
    } catch (err) {
      // Startup must not crash the MCP server; surface through tools.
      this.initError = (err as Error).message;
    }
  }

  private async claim(require: string[], exclude: string[] = []): Promise<void> {
    const claim = await claimFromPool({ base: this.opts.base, require, exclude });
    if (claim) {
      this.setHeld(claim);
      return;
    }
    if (require.length > 0) {
      throw new NoIdentityError(
        `no free identity with capabilities [${require.join(",")}]. ` +
        `Onboard a new one (see README: GitHub onboarding) or free one up ` +
        `(inspect ~/.config/agent-identity/claims/).`,
      );
    }
    // Plain exhaustion: mint a new identity.
    if (!this.opts.fleetKey) {
      throw new NoIdentityError(
        "pool is empty and AGENT_IDENTITY_FLEET_KEY is not set, so a new identity cannot be registered",
      );
    }
    const keypair = generateKeypair();
    const client = this.makeClientFn(keypair);
    const identity = await client.register();
    const profile: PoolProfile & { agentId: string } = { ...keypair, ...identity };
    savePoolProfile(profile, this.opts.base);
    const created = await claimFromPool({ base: this.opts.base, exclude });
    if (!created) throw new NoIdentityError("could not claim freshly created identity");
    this.setHeld(created);
  }

  private setHeld(claim: Claim): void {
    this.held = { claim, client: this.makeClientFn(claim.profile) };
    this.initError = undefined;
  }

  client(): AgentClientLike {
    if (!this.held) {
      throw new NoIdentityError(this.initError ?? "no identity claimed for this session");
    }
    return this.held.client;
  }

  async ensureIdentity(require?: string[]): Promise<AgentIdentity> {
    const effective = require ?? this.opts.require ?? [];
    if (this.held && !hasCapabilities(this.held.claim.profile, effective)) {
      // Claim the qualifying profile FIRST; only then release the old one,
      // so a failed swap never leaves the session identity-less.
      const previous = this.held;
      await this.claim(effective, [previous.claim.name]);
      previous.claim.release();
    } else if (!this.held) {
      await this.claim(effective);
    }
    const identity = await this.held!.client.register();
    savePoolProfile(
      { ...this.held!.claim.profile, ...identity }, this.opts.base,
    );
    this.held!.claim.profile.agentId = identity.agentId;
    this.held!.claim.profile.address = identity.address;
    return identity;
  }

  status(): IdentityStatus {
    return {
      held: this.held
        ? {
            name: this.held.claim.name,
            agentId: this.held.claim.profile.agentId,
            address: this.held.claim.profile.address,
            capabilities: capsOf(this.held.claim.profile),
          }
        : null,
      ...(this.initError ? { initError: this.initError } : {}),
      pool: poolStatus({ base: this.opts.base }),
    };
  }

  release(): void {
    this.held?.claim.release();
    this.held = undefined;
  }
}
```

Note: `poolStatus` counts the manager's own held profile as claimed (its lock is live) — that is what the swap test asserts with `freeByCapability: {}`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test -- claim-manager`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/claim-manager.ts packages/mcp/src/claim-manager.test.ts
git commit -m "feat(mcp): ClaimManager — claim at startup, swap on require, release on exit"
```

---

### Task 6: Tools + server wiring

**Files:**
- Modify: `packages/mcp/src/tools.ts`
- Modify: `packages/mcp/src/tools.test.ts`
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Rewrite tools tests for the manager interface**

Replace `packages/mcp/src/tools.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeTools } from "./tools.js";

function makeClient(over: Record<string, unknown> = {}) {
  return {
    register: vi.fn(async () => ({ agentId: "482913", address: "482913@d" })),
    listEmails: vi.fn(async () => ({ emails: [] })),
    getEmail: vi.fn(async () => ({ id: "01A", from: "a", subject: "s", receivedAt: "t", text: "b", links: [] })),
    ...over,
  };
}

function makeManager(client = makeClient()) {
  return {
    client: () => client,
    ensureIdentity: vi.fn(async (_require?: string[]) => ({ agentId: "482913", address: "482913@d" })),
    status: vi.fn(() => ({ held: { name: "482913", capabilities: [] }, pool: { total: 1, free: 0, freeByCapability: {} } })),
  } as never;
}

describe("mcp tools", () => {
  it("ensure_identity delegates to the manager with require", async () => {
    const mgr = makeManager();
    const tools = makeTools(mgr);
    const res = await tools.ensureIdentity({ require: ["github"] });
    expect(res).toEqual({ agentId: "482913", address: "482913@d" });
    expect((mgr as { ensureIdentity: ReturnType<typeof vi.fn> }).ensureIdentity)
      .toHaveBeenCalledWith(["github"]);
  });

  it("identity_status reports manager status", () => {
    const tools = makeTools(makeManager());
    expect(tools.identityStatus()).toEqual(
      expect.objectContaining({ held: expect.objectContaining({ name: "482913" }) }),
    );
  });

  it("wait_for_email returns first match", async () => {
    const client = makeClient({
      listEmails: vi.fn(async () => ({
        emails: [
          { id: "1", from: "spam@x", subject: "junk", receivedAt: "t" },
          { id: "2", from: "noreply@github.com", subject: "Verify your email", receivedAt: "t" },
        ],
      })),
    });
    const tools = makeTools(makeManager(client));
    const res = await tools.waitForEmail(
      { fromContains: "github", timeoutSeconds: 1 }, { pollMs: 10 },
    );
    expect(res).toEqual(expect.objectContaining({ id: "2" }));
  });

  it("wait_for_email times out cleanly (result, not throw)", async () => {
    const tools = makeTools(makeManager());
    const res = await tools.waitForEmail({ subjectContains: "never", timeoutSeconds: 0.05 }, { pollMs: 10 });
    expect(res).toEqual({ timedOut: true });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- tools`
Expected: FAIL — `makeTools` still has the `(client, persistIdentity)` signature.

- [ ] **Step 3: Rewrite `tools.ts`**

```ts
// packages/mcp/src/tools.ts
import type { EmailSummary } from "@agent-identity/shared";
import type { ClaimManager } from "./claim-manager.js";

export interface WaitArgs {
  fromContains?: string;
  subjectContains?: string;
  timeoutSeconds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeTools(manager: ClaimManager) {
  return {
    ensureIdentity(args: { require?: string[] } = {}) {
      return manager.ensureIdentity(args.require);
    },

    identityStatus() {
      return manager.status();
    },

    listEmails(opts: { since?: string; limit?: number }) {
      return manager.client().listEmails(opts);
    },

    getEmail(id: string) {
      return manager.client().getEmail(id);
    },

    async waitForEmail(
      args: WaitArgs, opts: { pollMs?: number } = {},
    ): Promise<EmailSummary | { timedOut: true }> {
      const pollMs = opts.pollMs ?? 5000;
      const deadline = Date.now() + args.timeoutSeconds * 1000;
      // 15-minute lookback: the email often arrives before polling starts,
      // e.g. while a human finishes a signup form the agent asked them to fill.
      const since = new Date(Date.now() - 900_000).toISOString();
      const matches = (e: EmailSummary) =>
        (!args.fromContains || e.from.toLowerCase().includes(args.fromContains.toLowerCase())) &&
        (!args.subjectContains || e.subject.toLowerCase().includes(args.subjectContains.toLowerCase()));
      for (;;) {
        const { emails } = await manager.client().listEmails({ since, limit: 50 });
        const hit = emails.find(matches);
        if (hit) return hit;
        if (Date.now() >= deadline) return { timedOut: true };
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      }
    },
  };
}
```

(The test's fake manager is structurally compatible; `ClaimManager` here is used as a structural type.)

If `tools.test.ts` type-errors on the fake (`as never` casts cover it), keep the casts as shown in Step 1.

- [ ] **Step 4: Rewrite `server.ts`**

```ts
// packages/mcp/src/server.ts
#!/usr/bin/env -S npx tsx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClaimManager } from "./claim-manager.js";
import { makeTools } from "./tools.js";

const require = (process.env.AGENT_IDENTITY_REQUIRE ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const manager = new ClaimManager({
  apiUrl: process.env.AGENT_IDENTITY_API_URL!,
  fleetKey: process.env.AGENT_IDENTITY_FLEET_KEY,
  require,
});
await manager.init();

process.on("exit", () => manager.release());
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => process.exit(0));
}

const tools = makeTools(manager);
const server = new McpServer({ name: "agent-identity", version: "0.1.0" });
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

server.registerTool(
  "ensure_identity",
  {
    description: "Claim/confirm this session's identity and mailbox address. Idempotent; call at session start. Pass require:[\"github\"] to swap to a GitHub-capable identity.",
    inputSchema: { require: z.array(z.string()).optional() },
  },
  async (args) => json(await tools.ensureIdentity(args)),
);

server.registerTool(
  "identity_status",
  {
    description: "Show the identity this session holds, its capabilities, and pool availability.",
    inputSchema: {},
  },
  async () => json(tools.identityStatus()),
);

server.registerTool(
  "list_emails",
  {
    description: "List received emails, newest first.",
    inputSchema: { since: z.string().optional(), limit: z.number().int().max(50).optional() },
  },
  async (args) => json(await tools.listEmails(args)),
);

server.registerTool(
  "get_email",
  {
    description: "Get a full email by id, including body text and extracted links.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => json(await tools.getEmail(id)),
);

server.registerTool(
  "wait_for_email",
  {
    description: "Poll until an email matching the filters arrives, or timeout (returns {timedOut:true}).",
    inputSchema: {
      fromContains: z.string().optional(),
      subjectContains: z.string().optional(),
      timeoutSeconds: z.number().max(300).default(120),
    },
  },
  async (args) => json(await tools.waitForEmail(args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Note the deliberate changes from the old server: no more `AGENT_IDENTITY_PROFILE` / `loadOrCreateProfile` — the pool + claim replaces it.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all passing (claims 17, claim-manager 7, tools 4, plus existing suites).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools.ts packages/mcp/src/tools.test.ts packages/mcp/src/server.ts
git commit -m "feat(mcp): claim-managed identity — require override, identity_status, exit release"
```

---

### Task 7: API — capabilities on the agent record and `/me`

**Files:**
- Modify: `packages/api/src/db/agents.ts:7-11`
- Modify: `packages/api/src/app.ts:31-34`
- Modify: `packages/api/src/app.test.ts`

- [ ] **Step 1: Write failing test** (append inside `describe("app", ...)` in `app.test.ts`)

```ts
  it("GET /me returns capabilities (empty when untagged)", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/me", signed("GET", "/me"));
    expect(await res.json()).toEqual({ agentId: "482913", address: "482913@d", capabilities: [] });
  });

  it("GET /me returns capabilities when the record is tagged", async () => {
    const deps = makeDeps({
      getByFingerprint: vi.fn(async () => ({ ...agent, capabilities: ["github"] })) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/me", signed("GET", "/me"));
    expect(await res.json()).toEqual(
      expect.objectContaining({ capabilities: ["github"] }),
    );
  });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- app`
Expected: FAIL — `/me` body lacks `capabilities`.

- [ ] **Step 3: Implement**

In `packages/api/src/db/agents.ts`, extend the record:

```ts
export interface AgentRecord extends AgentIdentity {
  publicKey: string;
  status: "active" | "revoked";
  createdAt: string;
  capabilities?: string[]; // operator-set via mailctl; registration never sets it
}
```

In `packages/api/src/app.ts`, replace the `/me` route:

```ts
  app.get("/me", (c) => {
    const { agentId, address, capabilities } = c.get("agent");
    return c.json({ agentId, address, capabilities: capabilities ?? [] });
  });
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm test -- app`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/db/agents.ts packages/api/src/app.ts packages/api/src/app.test.ts
git commit -m "feat(api): expose operator-set capabilities on /me"
```

---

### Task 8: Admin — `agent tag` / `agent untag`, capabilities in list

**Files:**
- Modify: `packages/admin/src/commands.ts`
- Create: `packages/admin/src/commands.test.ts`
- Modify: `packages/admin/src/mailctl.ts:25-32`

- [ ] **Step 1: Write failing tests**

```ts
// packages/admin/src/commands.test.ts
import { describe, expect, it, vi } from "vitest";
import { tagAgent, untagAgent } from "./commands.js";

// Fake DynamoDBDocumentClient: routes by command constructor name, records updates.
function fakeDdb(items: Record<string, Record<string, unknown> | undefined>) {
  const updates: unknown[] = [];
  return {
    updates,
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key?: { PK: string } } }) => {
      if (cmd.constructor.name === "GetCommand") {
        return { Item: items[cmd.input.Key!.PK] };
      }
      updates.push(cmd.input);
      return {};
    }),
  };
}

const addr = { PK: "ADDR#482913", fingerprint: "fp1" };
const agent = { PK: "AGENT#fp1", agentId: "482913", capabilities: ["email"] };

describe("tagAgent / untagAgent", () => {
  it("tagAgent adds a capability (deduped, sorted)", async () => {
    const ddb = fakeDdb({ "ADDR#482913": addr, "AGENT#fp1": agent });
    await tagAgent(ddb as never, "T", "482913", "github");
    expect(ddb.updates[0]).toEqual(expect.objectContaining({
      Key: { PK: "AGENT#fp1", SK: "AGENT" },
      ExpressionAttributeValues: { ":c": ["email", "github"] },
    }));
  });

  it("tagAgent is idempotent", async () => {
    const ddb = fakeDdb({ "ADDR#482913": addr, "AGENT#fp1": { ...agent, capabilities: ["github"] } });
    await tagAgent(ddb as never, "T", "482913", "github");
    expect(ddb.updates[0]).toEqual(expect.objectContaining({
      ExpressionAttributeValues: { ":c": ["github"] },
    }));
  });

  it("untagAgent removes a capability", async () => {
    const ddb = fakeDdb({ "ADDR#482913": addr, "AGENT#fp1": { ...agent, capabilities: ["email", "github"] } });
    await untagAgent(ddb as never, "T", "482913", "github");
    expect(ddb.updates[0]).toEqual(expect.objectContaining({
      ExpressionAttributeValues: { ":c": ["email"] },
    }));
  });

  it("throws for an unknown agentId", async () => {
    const ddb = fakeDdb({});
    await expect(tagAgent(ddb as never, "T", "000000", "github"))
      .rejects.toThrow(/no agent with id 000000/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- commands`
Expected: FAIL — `tagAgent` not exported.

- [ ] **Step 3: Implement** (append to `commands.ts`; also extend `AgentRow` and `listAgents`)

```ts
async function agentKeyByLocalPart(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
): Promise<{ PK: string; SK: string }> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: table, Key: { PK: `ADDR#${agentId}`, SK: "ADDR" },
  }));
  if (!Item) throw new Error(`no agent with id ${agentId}`);
  return { PK: `AGENT#${Item.fingerprint}`, SK: "AGENT" };
}

async function setCapabilities(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
  mutate: (caps: Set<string>) => void,
): Promise<void> {
  const key = await agentKeyByLocalPart(ddb, table, agentId);
  const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  const caps = new Set<string>((Item?.capabilities as string[]) ?? []);
  mutate(caps);
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: "SET capabilities = :c",
    ExpressionAttributeValues: { ":c": [...caps].sort() },
  }));
}

export function tagAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string, capability: string,
): Promise<void> {
  return setCapabilities(ddb, table, agentId, (caps) => caps.add(capability));
}

export function untagAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string, capability: string,
): Promise<void> {
  return setCapabilities(ddb, table, agentId, (caps) => caps.delete(capability));
}
```

Update `AgentRow` and `listAgents` (modify existing code):

```ts
export interface AgentRow {
  fingerprint: string;
  agentId: string;
  address: string;
  status: string;
  capabilities: string;
}
```

and in `listAgents`'s map, add:

```ts
    capabilities: ((i.capabilities as string[]) ?? []).join(","),
```

- [ ] **Step 4: Wire into `mailctl.ts`** (append after the existing `agent.command("revoke ...")` block)

```ts
agent.command("tag <agentId> <capability>").action(async (agentId: string, capability: string) => {
  await tagAgent(ddb, table, agentId, capability);
  console.log(`tagged ${agentId} +${capability}`);
});
agent.command("untag <agentId> <capability>").action(async (agentId: string, capability: string) => {
  await untagAgent(ddb, table, agentId, capability);
  console.log(`untagged ${agentId} -${capability}`);
});
```

and extend the import at the top of `mailctl.ts`:

```ts
import { createFleetKey, listAgents, revokeAgent, tagAgent, untagAgent } from "./commands.js";
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `pnpm test`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add packages/admin/src/commands.ts packages/admin/src/commands.test.ts packages/admin/src/mailctl.ts
git commit -m "feat(admin): mailctl agent tag/untag and capabilities in agent list"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Session identity claiming" section**

Cover, in this order (write against the actual behavior implemented above):

```markdown
## Session identity claiming

Each MCP server process claims one identity from a machine-local pool at
startup and holds it for its lifetime. Concurrent sessions get distinct
identities; identities are reused across sessions rather than re-created.

### Pool layout

~/.config/agent-identity/
  pool/<agentId>.json   claimable profiles (keypair + address + optional github block)
  claims/<agentId>.lock existence = claimed; contains {pid, claimedAt, host}

Profiles outside pool/ (e.g. default.json) are never claimed.

### Requiring a GitHub-capable identity

Set `AGENT_IDENTITY_REQUIRE=github` in the MCP server's env (e.g. in
.mcp.json). The agent can also call `ensure_identity` with
`{"require": ["github"]}` to swap mid-session. If no GitHub-capable
identity is free, the claim fails with remediation instructions — it is
never auto-created. A plain identity IS auto-created (and added to the
pool) when the pool is exhausted, using AGENT_IDENTITY_FLEET_KEY.

Use the `identity_status` tool to see what is held and what is free.

### Onboarding a GitHub-capable identity

1. A session claims/mints a plain identity, e.g. 482913@<domain>.
2. A human creates the GitHub account with that address (form + CAPTCHA);
   the agent fetches the verification email via wait_for_email.
3. `mailctl agent tag 482913 github`
4. `agent-identity github link 482913 --username <gh-login> [--credential-ref op://...]`

### Stuck locks

A crashed holder's lock is reclaimed automatically (dead-PID detection).
After a reboot, PID reuse can rarely leave a stale lock that looks live:
delete the file in ~/.config/agent-identity/claims/ by hand.

### Optional SessionStart hook

Claiming needs no hook. To surface the identity to the agent at session
start, add to .claude/settings.json:

    { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "echo 'agent-identity MCP is available; call ensure_identity before workflows needing email.'" }] }] } }
```

- [ ] **Step 2: Verify suite still green**

Run: `pnpm test`
Expected: all passing.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: session identity claiming — pool, require, onboarding, stuck locks"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full suite + typecheck**

```bash
pnpm test
pnpm exec tsc --noEmit -p packages/client 2>/dev/null || (cd packages/client && ../../node_modules/.bin/tsc --noEmit)
```

(If a package has no tsconfig, skip its typecheck — vitest already type-executes the code. `infra/` is untouched by this plan.)

Expected: everything green.

- [ ] **Step 2: Verify signatures**

```bash
git log --format="%h %G? %s" origin/main..HEAD
```

Expected: every commit shows `G`.

- [ ] **Step 3: Review the diff as a whole**

```bash
git diff origin/main...HEAD --stat
```

Confirm only the files listed in this plan's File structure table changed (plus lockfile).

---

## Out of scope (do not build)

- Server-side lease pool / `/claim` endpoints (fleet phase; see issues #22/#23 for the access-control-layer direction).
- Mailbox visibility boundaries per claim.
- Any automated GitHub signup.
- DynamoDB schema migration — `capabilities` is a new optional attribute; existing items need no backfill.
