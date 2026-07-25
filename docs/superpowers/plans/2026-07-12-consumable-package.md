# Consumable Package & Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish agent-identity as `@critical-labs/agent-identity` on npm (MCP server + client + CLIs in one package) with an interactive `agent-identity setup` wizard that onboards a consuming repo.

**Architecture:** All new logic lives in `packages/client/src/` (config files, provisioning, wizard) so the monorepo dev flow and tests cover it. A new aggregate package `packages/dist/` bundles `client`, `mcp`, and `shared` into `dist/` via tsup with real node shebangs and ships a `skill/` directory; it is the only published artifact. The MCP server gains a fleet-key file fallback so `.mcp.json` never contains a secret.

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, commander, `node:readline/promises`, tsup, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-12-consumable-package-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `packages/client/src/config.ts` (new) | Machine config `~/.config/agent-identity/config.json` + fleet-key file read/write + `resolveFleetKey` precedence |
| `packages/client/src/provision.ts` (new) | `provisionIdentities` — mint N identities into the pool, continue on failure |
| `packages/client/src/setup.ts` (new) | Pure setup pieces: `validateApiUrl`, `mergeMcpJson`, `skillDest`, `installSkill` |
| `packages/client/src/checklist.ts` (new) | Deploy-new guided checklist steps + injectable verification deps |
| `packages/client/src/wizard.ts` (new) | `runSetup` interactive loop over injectable IO |
| `packages/client/src/cli.ts` (modify) | New commands: `setup`, `pool provision`, `pool status` |
| `packages/client/src/index.ts` (modify) | Export new modules |
| `packages/client/package.json` (modify) | Add `./cli` export |
| `packages/mcp/src/server.ts` (modify) | Fleet key falls back to `~/.config/agent-identity/fleet_key` |
| `packages/mcp/package.json` (modify) | Add `./server` export |
| `packages/dist/package.json` (new) | `@critical-labs/agent-identity` manifest |
| `packages/dist/tsup.config.ts` (new) | Bundle config |
| `packages/dist/src/{index,cli,server}.ts` (new) | Thin entry points |
| `packages/dist/skill/SKILL.md` (new) | The bundled Claude Code skill |
| `packages/dist/README.md` (new) | npm-facing README |
| `.github/workflows/publish.yml` (new) | Publish on `v*` tag |
| `README.md` (modify) | Quick start via npm install + setup |

Existing helpers you will reuse (already in `packages/client/src/`): `defaultProfileDir()` (profile.ts), `savePoolProfile`, `poolStatus`, `linkGithub` (claims.ts), `AgentIdentityClient` (client.ts), `generateKeypair` (from `@agent-identity/shared`).

Conventions: tests are colocated `*.test.ts`, run with `pnpm vitest run <path>`; tmp dirs via `mkdtempSync(join(tmpdir(), "..."))`; files with secrets written mode 0o600; commits are small, signed automatically (never use `--no-gpg-sign` or `--no-verify`).

---

### Task 1: Machine config & fleet-key file (`config.ts`)

**Files:**
- Create: `packages/client/src/config.ts`
- Test: `packages/client/src/config.test.ts`
- Modify: `packages/client/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/src/config.test.ts
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fleetKeyPath, readFleetKeyFile, readMachineConfig, resolveFleetKey,
  writeFleetKeyFile, writeMachineConfig,
} from "./config.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-cfg-"));

describe("machine config", () => {
  it("round-trips apiUrl and writes mode 600", () => {
    const dir = base();
    writeMachineConfig({ apiUrl: "https://api.example" }, dir);
    expect(readMachineConfig(dir)).toEqual({ apiUrl: "https://api.example" });
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
  });

  it("returns {} when missing or corrupt", () => {
    const dir = base();
    expect(readMachineConfig(dir)).toEqual({});
  });
});

describe("fleet key file", () => {
  it("round-trips trimmed key with mode 600", () => {
    const dir = base();
    writeFleetKeyFile("  fk-123\n", dir);
    expect(readFleetKeyFile(dir)).toBe("fk-123");
    expect(statSync(fleetKeyPath(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(fleetKeyPath(dir), "utf8")).toBe("fk-123\n");
  });

  it("returns undefined when missing or empty", () => {
    const dir = base();
    expect(readFleetKeyFile(dir)).toBeUndefined();
    writeFleetKeyFile("", dir);
    expect(readFleetKeyFile(dir)).toBeUndefined();
  });
});

describe("resolveFleetKey", () => {
  it("prefers the env value over the file", () => {
    const dir = base();
    writeFleetKeyFile("from-file", dir);
    expect(resolveFleetKey("from-env", dir)).toBe("from-env");
  });

  it("falls back to the file, then undefined", () => {
    const dir = base();
    expect(resolveFleetKey(undefined, dir)).toBeUndefined();
    writeFleetKeyFile("from-file", dir);
    expect(resolveFleetKey(undefined, dir)).toBe("from-file");
    expect(resolveFleetKey("", dir)).toBe("from-file"); // empty env = unset
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/client/src/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`

- [ ] **Step 3: Implement `config.ts`**

```ts
// packages/client/src/config.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProfileDir } from "./profile.js";

export interface MachineConfig {
  apiUrl?: string;
}

export const machineConfigPath = (base: string = defaultProfileDir()): string =>
  join(base, "config.json");

export function readMachineConfig(base?: string): MachineConfig {
  try {
    return JSON.parse(readFileSync(machineConfigPath(base), "utf8")) as MachineConfig;
  } catch {
    return {};
  }
}

export function writeMachineConfig(config: MachineConfig, base: string = defaultProfileDir()): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(machineConfigPath(base), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export const fleetKeyPath = (base: string = defaultProfileDir()): string =>
  join(base, "fleet_key");

export function readFleetKeyFile(base?: string): string | undefined {
  try {
    const key = readFileSync(fleetKeyPath(base), "utf8").trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

export function writeFleetKeyFile(key: string, base: string = defaultProfileDir()): void {
  mkdirSync(base, { recursive: true });
  writeFileSync(fleetKeyPath(base), `${key.trim()}\n`, { mode: 0o600 });
}

export function resolveFleetKey(
  env: string | undefined = process.env.AGENT_IDENTITY_FLEET_KEY,
  base?: string,
): string | undefined {
  return env || readFleetKeyFile(base);
}
```

Append to `packages/client/src/index.ts`:

```ts
export * from "./config.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/client/src/config.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/config.ts packages/client/src/config.test.ts packages/client/src/index.ts
git commit -m "feat(client): machine config and fleet-key file with env-first resolution"
```

---

### Task 2: MCP server fleet-key file fallback

**Files:**
- Modify: `packages/mcp/src/server.ts:11-15`

The server currently reads only `process.env.AGENT_IDENTITY_FLEET_KEY`. `.mcp.json` is committed, so the key must be loadable from `~/.config/agent-identity/fleet_key` instead. The resolution logic is already tested in Task 1; this task is glue (the repo does not unit-test `server.ts`, consistent with its existing style).

- [ ] **Step 1: Apply the change**

In `packages/mcp/src/server.ts`, change the import of the claim manager block. Replace:

```ts
import { ClaimManager } from "./claim-manager.js";
```

with:

```ts
import { resolveFleetKey } from "@agent-identity/client";
import { ClaimManager } from "./claim-manager.js";
```

and replace:

```ts
const manager = new ClaimManager({
  apiUrl: process.env.AGENT_IDENTITY_API_URL!,
  fleetKey: process.env.AGENT_IDENTITY_FLEET_KEY,
  require: requiredCaps,
});
```

with:

```ts
const manager = new ClaimManager({
  apiUrl: process.env.AGENT_IDENTITY_API_URL!,
  fleetKey: resolveFleetKey(),
  require: requiredCaps,
});
```

Note: `packages/mcp/package.json` already depends on `@agent-identity/client`.

- [ ] **Step 2: Run the full suite (regression check)**

Run: `pnpm vitest run`
Expected: all tests pass (89 existing + 6 from Task 1)

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): fall back to ~/.config/agent-identity/fleet_key when env is unset"
```

---

### Task 3: Identity provisioning (`provision.ts`)

**Files:**
- Create: `packages/client/src/provision.ts`
- Test: `packages/client/src/provision.test.ts`
- Modify: `packages/client/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/src/provision.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPool } from "./claims.js";
import { provisionIdentities } from "./provision.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-prov-"));

// Fake factory: register() returns sequential identities; ids 900000+n.
function fakeFactory(failOn: number[] = []) {
  let n = 0;
  return () => {
    const i = n++;
    return {
      register: async () => {
        if (failOn.includes(i)) throw new Error(`boom ${i}`);
        return { agentId: `90000${i}`, address: `90000${i}@d` };
      },
    };
  };
}

describe("provisionIdentities", () => {
  it("mints count identities into the pool", async () => {
    const dir = base();
    const results = await provisionIdentities({
      count: 3, apiUrl: "https://api", fleetKey: "fk", base: dir,
      makeClient: fakeFactory(),
    });
    expect(results).toEqual([
      { agentId: "900000", address: "900000@d" },
      { agentId: "900001", address: "900001@d" },
      { agentId: "900002", address: "900002@d" },
    ]);
    expect(listPool(dir).map((p) => p.name)).toEqual(["900000", "900001", "900002"]);
  });

  it("continues past failures and reports them per identity", async () => {
    const dir = base();
    const results = await provisionIdentities({
      count: 3, apiUrl: "https://api", fleetKey: "fk", base: dir,
      makeClient: fakeFactory([1]),
    });
    expect(results[0]).toEqual({ agentId: "900000", address: "900000@d" });
    expect(results[1]).toEqual({ error: "boom 1" });
    expect(results[2]).toEqual({ agentId: "900002", address: "900002@d" });
    expect(listPool(dir)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/client/src/provision.test.ts`
Expected: FAIL — `Cannot find module './provision.js'`

- [ ] **Step 3: Implement `provision.ts`**

```ts
// packages/client/src/provision.ts
import { generateKeypair, type AgentIdentity, type Keypair } from "@agent-identity/shared";
import { savePoolProfile } from "./claims.js";
import { AgentIdentityClient } from "./client.js";

export interface ProvisionClientLike {
  register(): Promise<AgentIdentity>;
}

export interface ProvisionOptions {
  count: number;
  apiUrl: string;
  fleetKey: string;
  base?: string;
  makeClient?: (keypair: Keypair) => ProvisionClientLike;
}

export interface ProvisionResult {
  agentId?: string;
  address?: string;
  error?: string;
}

export async function provisionIdentities(opts: ProvisionOptions): Promise<ProvisionResult[]> {
  const makeClient = opts.makeClient
    ?? ((keypair: Keypair) => new AgentIdentityClient({
      apiUrl: opts.apiUrl, keypair, fleetKey: opts.fleetKey,
    }));
  const results: ProvisionResult[] = [];
  for (let i = 0; i < opts.count; i++) {
    const keypair = generateKeypair();
    try {
      const identity = await makeClient(keypair).register();
      savePoolProfile({ ...keypair, ...identity }, opts.base);
      results.push({ agentId: identity.agentId, address: identity.address });
    } catch (err) {
      results.push({ error: (err as Error).message });
    }
  }
  return results;
}
```

Append to `packages/client/src/index.ts`:

```ts
export * from "./provision.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/client/src/provision.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/provision.ts packages/client/src/provision.test.ts packages/client/src/index.ts
git commit -m "feat(client): pool provisioning with per-identity failure reporting"
```

---

### Task 4: Setup pure pieces (`setup.ts`)

**Files:**
- Create: `packages/client/src/setup.ts`
- Test: `packages/client/src/setup.test.ts`
- Modify: `packages/client/src/index.ts`

Background: an unauthenticated `GET /me` against the real API returns HTTP 401 `{"error":"missing auth headers"}` (see `packages/api/src/auth.ts:20`) — that is the reachability probe. `.mcp.json` entries use `npx agent-identity-mcp` because MCP clients spawn commands without `node_modules/.bin` on PATH.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/src/setup.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installSkill, mergeMcpJson, skillDest, validateApiUrl } from "./setup.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aid-setup-"));

describe("validateApiUrl", () => {
  it("accepts a reachable API that answers 401", async () => {
    expect(await validateApiUrl("https://api.example", async () => ({ status: 401 })))
      .toBeUndefined();
  });

  it("strips a trailing slash before probing /me", async () => {
    let probed = "";
    await validateApiUrl("https://api.example/", async (url) => {
      probed = url;
      return { status: 401 };
    });
    expect(probed).toBe("https://api.example/me");
  });

  it("rejects unexpected statuses with the observed status", async () => {
    const err = await validateApiUrl("https://api.example", async () => ({ status: 404 }));
    expect(err).toMatch(/unexpected response 404/);
  });

  it("rejects unreachable hosts with the failure message", async () => {
    const err = await validateApiUrl("https://api.example", async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    expect(err).toMatch(/could not reach/);
    expect(err).toMatch(/ENOTFOUND/);
  });
});

describe("mergeMcpJson", () => {
  it("creates a fresh document when none exists", () => {
    const doc = JSON.parse(mergeMcpJson(undefined, { apiUrl: "https://api", requireGithub: false }));
    expect(doc.mcpServers["agent-identity"]).toEqual({
      command: "npx",
      args: ["agent-identity-mcp"],
      env: { AGENT_IDENTITY_API_URL: "https://api" },
    });
  });

  it("sets AGENT_IDENTITY_REQUIRE=github when asked", () => {
    const doc = JSON.parse(mergeMcpJson(undefined, { apiUrl: "https://api", requireGithub: true }));
    expect(doc.mcpServers["agent-identity"].env.AGENT_IDENTITY_REQUIRE).toBe("github");
  });

  it("preserves other servers and top-level keys", () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: "x" } },
      unrelated: true,
    });
    const doc = JSON.parse(mergeMcpJson(existing, { apiUrl: "https://api", requireGithub: false }));
    expect(doc.mcpServers.other).toEqual({ command: "x" });
    expect(doc.unrelated).toBe(true);
    expect(doc.mcpServers["agent-identity"].env.AGENT_IDENTITY_API_URL).toBe("https://api");
  });

  it("throws on unparseable JSON instead of clobbering", () => {
    expect(() => mergeMcpJson("{nope", { apiUrl: "https://api", requireGithub: false }))
      .toThrow(/not valid JSON/);
  });
});

describe("installSkill", () => {
  it("copies the skill directory into .claude/skills/agent-identity", () => {
    const src = tmp();
    writeFileSync(join(src, "SKILL.md"), "# skill");
    const repo = tmp();
    const dest = installSkill(src, repo);
    expect(dest).toBe(skillDest(repo));
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("# skill");
  });

  it("throws when the skill source is missing", () => {
    const repo = tmp();
    expect(() => installSkill(join(repo, "nope"), repo)).toThrow(/skill files not found/);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/client/src/setup.test.ts`
Expected: FAIL — `Cannot find module './setup.js'`

- [ ] **Step 3: Implement `setup.ts`**

```ts
// packages/client/src/setup.ts
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type FetchLike = (url: string) => Promise<{ status: number }>;

/** Returns an error message, or undefined when the URL answers like an agent-identity API. */
export async function validateApiUrl(
  apiUrl: string,
  fetchFn: FetchLike = (url) => globalThis.fetch(url),
): Promise<string | undefined> {
  const probe = `${apiUrl.replace(/\/+$/, "")}/me`;
  let status: number;
  try {
    status = (await fetchFn(probe)).status;
  } catch (err) {
    return `could not reach ${probe}: ${(err as Error).message}`;
  }
  if (status !== 401) {
    return `unexpected response ${status} from ${probe} (expected 401 from an agent-identity API)`;
  }
  return undefined;
}

export interface McpEntryOptions {
  apiUrl: string;
  requireGithub: boolean;
}

export function mergeMcpJson(existing: string | undefined, opts: McpEntryOptions): string {
  let doc: Record<string, unknown>;
  if (existing === undefined || existing.trim() === "") {
    doc = {};
  } else {
    try {
      doc = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new Error(".mcp.json exists but is not valid JSON; fix it and re-run setup");
    }
  }
  const servers = { ...(doc.mcpServers as Record<string, unknown> | undefined) };
  servers["agent-identity"] = {
    command: "npx",
    args: ["agent-identity-mcp"],
    env: {
      AGENT_IDENTITY_API_URL: opts.apiUrl,
      ...(opts.requireGithub ? { AGENT_IDENTITY_REQUIRE: "github" } : {}),
    },
  };
  return `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`;
}

export const skillDest = (repoRoot: string): string =>
  join(repoRoot, ".claude", "skills", "agent-identity");

export function installSkill(skillSrcDir: string, repoRoot: string): string {
  if (!existsSync(join(skillSrcDir, "SKILL.md"))) {
    throw new Error(`skill files not found at ${skillSrcDir}`);
  }
  const dest = skillDest(repoRoot);
  mkdirSync(dest, { recursive: true });
  cpSync(skillSrcDir, dest, { recursive: true });
  return dest;
}
```

Append to `packages/client/src/index.ts`:

```ts
export * from "./setup.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/client/src/setup.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/setup.ts packages/client/src/setup.test.ts packages/client/src/index.ts
git commit -m "feat(client): setup primitives — API probe, .mcp.json merge, skill install"
```

---

### Task 5: Deploy-new guided checklist (`checklist.ts`)

**Files:**
- Create: `packages/client/src/checklist.ts`
- Test: `packages/client/src/checklist.test.ts`
- Modify: `packages/client/src/index.ts`

The checklist mirrors the README "Deploy (operator)" steps. The CDK stack name is `AgentIdentity` (see `infra/bin`). Verifications run through injectable deps so tests never touch AWS or DNS. The wizard never modifies AWS state — it only verifies.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/src/checklist.test.ts
import { describe, expect, it } from "vitest";
import { deployChecklist, type ChecklistDeps } from "./checklist.js";

const okRun = async () => ({ ok: true, output: '{"Rules": []}' });
const failRun = async () => ({ ok: false, output: "AccessDenied" });

const deps = (over: Partial<ChecklistDeps> = {}): ChecklistDeps => ({
  run: okRun,
  resolveMx: async () => [{ exchange: "inbound-smtp.us-east-1.amazonaws.com" }],
  ...over,
});

describe("deployChecklist", () => {
  it("covers clone, credentials, deploy, ses identity, mx, rule set, fleet key in order", () => {
    expect(deployChecklist().map((s) => s.title)).toEqual([
      "Clone the agent-identity repository",
      "AWS credentials",
      "CDK bootstrap and deploy",
      "SES domain identity and DNS verification records",
      "MX record",
      "Activate the SES receipt rule set",
      "Mint a fleet key",
    ]);
  });

  it("steps without verification are informational", () => {
    const steps = deployChecklist();
    expect(steps[0].verify).toBeUndefined(); // clone
    expect(steps[6].verify).toBeUndefined(); // fleet key (prompted afterwards)
  });

  it("verifies AWS credentials via sts get-caller-identity", async () => {
    let cmd: string[] = [];
    const d = deps({ run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: "{}" }; } });
    expect(await deployChecklist()[1].verify!(d, { domain: "mail.example.com" })).toBeUndefined();
    expect(cmd).toEqual(["aws", "sts", "get-caller-identity"]);
    expect(await deployChecklist()[1].verify!(deps({ run: failRun }), { domain: "d" }))
      .toMatch(/AccessDenied/);
  });

  it("verifies the stack via describe-stacks AgentIdentity", async () => {
    let cmd: string[] = [];
    const d = deps({ run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: "{}" }; } });
    expect(await deployChecklist()[2].verify!(d, { domain: "mail.example.com" })).toBeUndefined();
    expect(cmd).toEqual(["aws", "cloudformation", "describe-stacks", "--stack-name", "AgentIdentity"]);
  });

  it("verifies the SES identity for the domain", async () => {
    let cmd: string[] = [];
    const d = deps({ run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: "{}" }; } });
    expect(await deployChecklist()[3].verify!(d, { domain: "mail.example.com" })).toBeUndefined();
    expect(cmd).toEqual(["aws", "sesv2", "get-email-identity", "--email-identity", "mail.example.com"]);
  });

  it("verifies MX resolution and reports lookup failures", async () => {
    expect(await deployChecklist()[4].verify!(deps(), { domain: "mail.example.com" })).toBeUndefined();
    const noMx = deps({ resolveMx: async () => [] });
    expect(await deployChecklist()[4].verify!(noMx, { domain: "d" })).toMatch(/no MX record/);
    const dnsErr = deps({ resolveMx: async () => { throw new Error("ENODATA"); } });
    expect(await deployChecklist()[4].verify!(dnsErr, { domain: "d" })).toMatch(/ENODATA/);
  });

  it("verifies an active receipt rule set exists", async () => {
    expect(await deployChecklist()[5].verify!(deps(), { domain: "d" })).toBeUndefined();
    const empty = deps({ run: async () => ({ ok: true, output: "" }) });
    expect(await deployChecklist()[5].verify!(empty, { domain: "d" })).toMatch(/no active receipt rule set/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/client/src/checklist.test.ts`
Expected: FAIL — `Cannot find module './checklist.js'`

- [ ] **Step 3: Implement `checklist.ts`**

```ts
// packages/client/src/checklist.ts
import { execFile } from "node:child_process";
import { resolveMx as dnsResolveMx } from "node:dns/promises";

export type RunCmd = (bin: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

export interface ChecklistDeps {
  run: RunCmd;
  resolveMx: (domain: string) => Promise<Array<{ exchange: string }>>;
}

export interface ChecklistContext {
  domain: string;
}

export interface ChecklistStep {
  title: string;
  /** Printed verbatim; contains the exact commands the operator runs. */
  instructions: string;
  /** Returns an error message, or undefined when the step is verified. */
  verify?: (deps: ChecklistDeps, ctx: ChecklistContext) => Promise<string | undefined>;
}

export function defaultChecklistDeps(): ChecklistDeps {
  return {
    run: (bin, args) =>
      new Promise((resolve) => {
        execFile(bin, args, (err, stdout, stderr) => {
          resolve({ ok: !err, output: err ? `${stdout}${stderr}`.trim() : stdout.trim() });
        });
      }),
    resolveMx: dnsResolveMx,
  };
}

export function deployChecklist(): ChecklistStep[] {
  return [
    {
      title: "Clone the agent-identity repository",
      instructions:
        "The CDK stack and mailctl are not published to npm, so deploying uses a source checkout:\n" +
        "  git clone https://github.com/critical-labs/agent-identity.git && cd agent-identity && pnpm install",
    },
    {
      title: "AWS credentials",
      instructions:
        "Log in with credentials for the target account (SES inbound requires us-east-1, us-west-2, or eu-west-1):\n" +
        "  aws configure   # or aws sso login / your usual method",
      verify: async ({ run }) => {
        const r = await run("aws", ["sts", "get-caller-identity"]);
        return r.ok ? undefined : `aws sts get-caller-identity failed: ${r.output}`;
      },
    },
    {
      title: "CDK bootstrap and deploy",
      instructions:
        "From the cloned repo:\n" +
        "  npx aws-cdk@2 bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION\n" +
        "  cd infra && npx cdk deploy -c domain=<your mail domain>\n" +
        "Note the ApiUrl, MxRecord, TableName, and ReceiptRuleSetName outputs.",
      verify: async ({ run }) => {
        const r = await run("aws", ["cloudformation", "describe-stacks", "--stack-name", "AgentIdentity"]);
        return r.ok ? undefined : `stack AgentIdentity not found: ${r.output}`;
      },
    },
    {
      title: "SES domain identity and DNS verification records",
      instructions:
        "Create the SES email identity and publish its DKIM/verification DNS records:\n" +
        "  aws sesv2 create-email-identity --email-identity <your mail domain>",
      verify: async ({ run }, { domain }) => {
        const r = await run("aws", ["sesv2", "get-email-identity", "--email-identity", domain]);
        return r.ok ? undefined : `SES identity for ${domain} not found: ${r.output}`;
      },
    },
    {
      title: "MX record",
      instructions:
        "Publish an MX record for your mail domain pointing at the stack's MxRecord output.",
      verify: async ({ resolveMx }, { domain }) => {
        try {
          const records = await resolveMx(domain);
          return records.length > 0 ? undefined : `no MX record found for ${domain}`;
        } catch (err) {
          return `MX lookup for ${domain} failed: ${(err as Error).message}`;
        }
      },
    },
    {
      title: "Activate the SES receipt rule set",
      instructions:
        "  aws ses set-active-receipt-rule-set --rule-set-name <ReceiptRuleSetName output>",
      verify: async ({ run }) => {
        const r = await run("aws", ["ses", "describe-active-receipt-rule-set"]);
        if (!r.ok) return `describe-active-receipt-rule-set failed: ${r.output}`;
        return r.output.includes("Rules") ? undefined : "no active receipt rule set";
      },
    },
    {
      title: "Mint a fleet key",
      instructions:
        "From the cloned repo:\n" +
        "  AGENT_IDENTITY_TABLE=<TableName output> npx tsx packages/admin/src/mailctl.ts fleet-key create --label setup\n" +
        "You will paste the key at the next prompt (it is stored at ~/.config/agent-identity/fleet_key).",
    },
  ];
}
```

Append to `packages/client/src/index.ts`:

```ts
export * from "./checklist.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/client/src/checklist.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/checklist.ts packages/client/src/checklist.test.ts packages/client/src/index.ts
git commit -m "feat(client): deploy-new guided checklist with injectable verification"
```

---

### Task 6: Setup wizard loop (`wizard.ts`)

**Files:**
- Create: `packages/client/src/wizard.ts`
- Test: `packages/client/src/wizard.test.ts`
- Modify: `packages/client/src/index.ts`

The wizard is a thin loop over injectable IO; every decision lives in the already-tested primitives. Prompt order: backend → (deploy path: domain + checklist) → API URL (validated, re-prompt on failure) → fleet key → provision count → require-github → `.mcp.json` write → skill install (with overwrite prompt).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/src/wizard.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readFleetKeyFile, readMachineConfig } from "./config.js";
import { skillDest } from "./setup.js";
import { runSetup, type SetupDeps } from "./wizard.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aid-wiz-"));

function scripted(answers: string[]) {
  const said: string[] = [];
  return {
    io: {
      ask: async () => answers.shift() ?? "",
      say: (m: string) => { said.push(m); },
    },
    said,
  };
}

function makeDeps(answers: string[], over: Partial<SetupDeps> = {}) {
  const cwd = tmp();
  const base = tmp();
  const skillDir = tmp();
  writeFileSync(join(skillDir, "SKILL.md"), "# skill");
  const { io, said } = scripted(answers);
  const provision = vi.fn(async ({ count }: { count: number }) =>
    Array.from({ length: count }, (_, i) => ({ agentId: `10000${i}`, address: `10000${i}@d` })));
  const deps: SetupDeps = {
    io, cwd, base, skillDir,
    fetchFn: async () => ({ status: 401 }),
    provision: provision as never,
    ...over,
  };
  return { deps, said, cwd, base, provision };
}

describe("runSetup — connect to existing", () => {
  it("persists config, provisions, writes .mcp.json, installs the skill", async () => {
    // backend=1, apiUrl, fleetKey, count=2, requireGithub=y
    const { deps, cwd, base, provision } = makeDeps(["1", "https://api.example", "fk-1", "2", "y"]);
    await runSetup(deps);
    expect(readMachineConfig(base)).toEqual({ apiUrl: "https://api.example" });
    expect(readFleetKeyFile(base)).toBe("fk-1");
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, apiUrl: "https://api.example", fleetKey: "fk-1", base }),
    );
    const mcp = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["agent-identity"].env).toEqual({
      AGENT_IDENTITY_API_URL: "https://api.example",
      AGENT_IDENTITY_REQUIRE: "github",
    });
    expect(existsSync(join(skillDest(cwd), "SKILL.md"))).toBe(true);
  });

  it("re-prompts until the API URL validates", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 401 });
    const { deps, said } = makeDeps(["1", "https://bad", "https://good", "fk", "0", "n"], { fetchFn });
    await runSetup(deps);
    expect(said.some((m) => m.includes("unexpected response 500"))).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps an existing fleet key when the prompt is left empty", async () => {
    const { deps, base } = makeDeps(["1", "https://api", "", "0", "n"]);
    const { writeFleetKeyFile } = await import("./config.js");
    writeFleetKeyFile("existing-key", base);
    await runSetup(deps);
    expect(readFleetKeyFile(base)).toBe("existing-key");
  });

  it("aborts without touching a corrupt .mcp.json", async () => {
    const { deps, cwd } = makeDeps(["1", "https://api", "fk", "0", "n"]);
    writeFileSync(join(cwd, ".mcp.json"), "{nope");
    await expect(runSetup(deps)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe("{nope");
  });

  it("asks before overwriting an installed skill and honours 'n'", async () => {
    // extra final answer "n" for the overwrite prompt
    const { deps, cwd } = makeDeps(["1", "https://api", "fk", "0", "n", "n"]);
    mkdirSync(skillDest(cwd), { recursive: true });
    writeFileSync(join(skillDest(cwd), "SKILL.md"), "old");
    await runSetup(deps);
    expect(readFileSync(join(skillDest(cwd), "SKILL.md"), "utf8")).toBe("old");
  });
});

describe("runSetup — deploy new", () => {
  it("walks the checklist, re-verifying failed steps", async () => {
    const verifyResults = ["not yet", undefined]; // first check fails, second passes
    const checklistDeps = {
      run: vi.fn(async () => {
        const r = verifyResults.shift();
        return r === undefined ? { ok: true, output: '{"Rules":[]}' } : { ok: false, output: r };
      }),
      resolveMx: async () => [{ exchange: "mx" }],
    };
    // backend=2, domain, then: enter for clone, enter+enter for credentials (fail, retry),
    // enter for deploy, ses, (mx auto-passes needs enter), rule set, fleet key step,
    // then apiUrl, fleetKey, count=0, require=n
    const answers = ["2", "mail.example.com", "", "", "", "", "", "", "", "",
      "https://api.example", "fk", "0", "n"];
    const { deps, said } = makeDeps(answers, { checklistDeps });
    await runSetup(deps);
    expect(said.some((m) => m.includes("Clone the agent-identity repository"))).toBe(true);
    expect(said.some((m) => m.includes("not yet"))).toBe(true);
    expect(said.some((m) => m.includes("Setup complete"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/client/src/wizard.test.ts`
Expected: FAIL — `Cannot find module './wizard.js'`

- [ ] **Step 3: Implement `wizard.ts`**

```ts
// packages/client/src/wizard.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultChecklistDeps, deployChecklist, type ChecklistDeps,
} from "./checklist.js";
import {
  readFleetKeyFile, readMachineConfig, writeFleetKeyFile, writeMachineConfig,
} from "./config.js";
import { provisionIdentities } from "./provision.js";
import {
  installSkill, mergeMcpJson, skillDest, validateApiUrl, type FetchLike,
} from "./setup.js";

export interface SetupIO {
  ask(question: string): Promise<string>;
  say(message: string): void;
}

export interface SetupDeps {
  io: SetupIO;
  cwd: string;                 // consuming repo root (where .mcp.json lives)
  skillDir: string;            // bundled skill source directory
  base?: string;               // config dir override (tests)
  fetchFn?: FetchLike;
  checklistDeps?: ChecklistDeps;
  provision?: typeof provisionIdentities;
}

export async function runSetup(deps: SetupDeps): Promise<void> {
  const { io } = deps;
  io.say("agent-identity setup");

  // 1. Backend
  let backend = "";
  while (backend !== "1" && backend !== "2") {
    backend = (await io.ask(
      "Backend: [1] connect to an existing deployment  [2] deploy a new one [1]: ",
    )).trim() || "1";
  }

  // 2. Deploy-new guided checklist
  if (backend === "2") {
    const domain = (await io.ask("Mail domain for the new deployment (e.g. mail.example.com): ")).trim();
    const cds = deps.checklistDeps ?? defaultChecklistDeps();
    for (const step of deployChecklist()) {
      io.say(`\n== ${step.title}\n${step.instructions}`);
      if (!step.verify) {
        await io.ask("Press enter to continue: ");
        continue;
      }
      for (;;) {
        await io.ask("Press enter once done (I'll verify): ");
        const err = await step.verify(cds, { domain });
        if (!err) {
          io.say("verified");
          break;
        }
        io.say(`not verified: ${err}`);
      }
    }
  }

  // 3. API URL (validated)
  const config = readMachineConfig(deps.base);
  let apiUrl = "";
  for (;;) {
    apiUrl = (await io.ask(
      `API URL${config.apiUrl ? ` [${config.apiUrl}]` : ""}: `,
    )).trim() || config.apiUrl || "";
    if (!apiUrl) continue;
    const err = await validateApiUrl(apiUrl, deps.fetchFn);
    if (!err) break;
    io.say(err);
  }
  writeMachineConfig({ ...config, apiUrl }, deps.base);

  // 4. Fleet key
  let fleetKey = readFleetKeyFile(deps.base);
  const keyAnswer = (await io.ask(
    fleetKey ? "Fleet key [keep existing]: " : "Fleet key: ",
  )).trim();
  if (keyAnswer) {
    writeFleetKeyFile(keyAnswer, deps.base);
    fleetKey = keyAnswer;
  }

  // 5. Provision
  const countAnswer = (await io.ask("How many identities should I provision now? [0]: ")).trim();
  const count = Number.parseInt(countAnswer || "0", 10) || 0;
  if (count > 0) {
    if (!fleetKey) {
      io.say("no fleet key available; skipping provisioning");
    } else {
      const provision = deps.provision ?? provisionIdentities;
      const results = await provision({ count, apiUrl, fleetKey, base: deps.base });
      for (const r of results) {
        io.say(r.error ? `failed: ${r.error}` : `minted ${r.agentId} <${r.address}>`);
      }
      io.say(`${results.filter((r) => !r.error).length}/${count} identities provisioned`);
    }
  }

  // 6. Require github?
  const requireGithub = (await io.ask(
    "Require a GitHub-capable identity for this repo? [y/N]: ",
  )).trim().toLowerCase().startsWith("y");

  // 7. .mcp.json
  const mcpPath = join(deps.cwd, ".mcp.json");
  let existing: string | undefined;
  try {
    existing = readFileSync(mcpPath, "utf8");
  } catch {
    existing = undefined;
  }
  writeFileSync(mcpPath, mergeMcpJson(existing, { apiUrl, requireGithub }));
  io.say(`wrote ${mcpPath}`);

  // 8. Skill
  let install = true;
  if (existsSync(skillDest(deps.cwd))) {
    install = !(await io.ask("Skill already installed; overwrite? [Y/n]: "))
      .trim().toLowerCase().startsWith("n");
  }
  if (install) {
    try {
      io.say(`installed skill at ${installSkill(deps.skillDir, deps.cwd)}`);
    } catch (err) {
      io.say(`skill not installed: ${(err as Error).message}`);
    }
  }

  io.say("\nSetup complete. Restart your Claude session and call ensure_identity.");
}
```

Append to `packages/client/src/index.ts`:

```ts
export * from "./wizard.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/client/src/wizard.test.ts`
Expected: PASS (7 tests). If the deploy-new test's answer count is off by one, count the `ask` calls in the transcript (`said` + prompts) and fix the answers array — the checklist has 7 steps: 2 informational (single enter) and 5 verified (one enter per verify attempt; the credentials step consumes two because its first verify fails).

- [ ] **Step 5: Run the whole suite**

Run: `pnpm vitest run`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/wizard.ts packages/client/src/wizard.test.ts packages/client/src/index.ts
git commit -m "feat(client): interactive setup wizard over injectable IO"
```

---

### Task 7: CLI commands — `setup`, `pool provision`, `pool status`

**Files:**
- Modify: `packages/client/src/cli.ts`

The CLI stays thin glue over tested functions (matching the existing `github link` style, which has no CLI-level tests). The skill directory defaults to `../skill` relative to the executing file — correct in the published package (`dist/cli.js` → `skill/`); in the dev checkout it does not exist, so `--skill-dir` overrides it and the wizard degrades gracefully otherwise.

- [ ] **Step 1: Rewrite `cli.ts`**

```ts
#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { linkGithub, poolStatus } from "./claims.js";
import { readMachineConfig, resolveFleetKey } from "./config.js";
import { provisionIdentities } from "./provision.js";
import { runSetup } from "./wizard.js";

const program = new Command("agent-identity");

const fail = (message: string): void => {
  console.error(`error: ${message}`);
  process.exitCode = 1;
};

program
  .command("setup")
  .description("interactive onboarding for a consuming repo: backend, identities, .mcp.json, skill")
  .option("--skill-dir <dir>", "override the bundled skill directory (dev checkouts)")
  .action(async (opts: { skillDir?: string }) => {
    const rl = readline.createInterface({ input, output });
    try {
      await runSetup({
        io: { ask: (q) => rl.question(q), say: (m) => console.log(m) },
        cwd: process.cwd(),
        skillDir: opts.skillDir
          ?? join(dirname(fileURLToPath(import.meta.url)), "..", "skill"),
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      rl.close();
    }
  });

const pool = program.command("pool").description("identity pool operations");

pool
  .command("provision")
  .description("mint identities into the machine-local pool")
  .requiredOption("--count <n>", "how many identities to mint")
  .option("--api-url <url>", "API base URL (default: machine config)")
  .option("--fleet-key <key>", "fleet key (default: env, then ~/.config/agent-identity/fleet_key)")
  .action(async (opts: { count: string; apiUrl?: string; fleetKey?: string }) => {
    const apiUrl = opts.apiUrl ?? readMachineConfig().apiUrl ?? process.env.AGENT_IDENTITY_API_URL;
    const fleetKey = opts.fleetKey ?? resolveFleetKey();
    if (!apiUrl) return fail("no API URL (pass --api-url or run: agent-identity setup)");
    if (!fleetKey) return fail("no fleet key (pass --fleet-key or run: agent-identity setup)");
    const count = Number.parseInt(opts.count, 10);
    if (!Number.isInteger(count) || count < 1) return fail("--count must be a positive integer");
    const results = await provisionIdentities({ count, apiUrl, fleetKey });
    for (const r of results) {
      console.log(r.error ? `failed: ${r.error}` : `minted ${r.agentId} <${r.address}>`);
    }
    const succeeded = results.filter((r) => !r.error).length;
    console.log(`${succeeded}/${count} identities provisioned`);
    if (succeeded === 0) process.exitCode = 1;
  });

pool
  .command("status")
  .description("show pool totals and free identities by capability")
  .action(() => {
    const s = poolStatus();
    console.log(`total: ${s.total}  free: ${s.free}`);
    for (const [cap, n] of Object.entries(s.freeByCapability)) {
      console.log(`free with ${cap}: ${n}`);
    }
  });

const github = program.command("github").description("GitHub account linkage");

github
  .command("link <agentId>")
  .description("record that this pool identity has a GitHub account")
  .requiredOption("--username <login>", "GitHub login of the account")
  .option("--credential-ref <ref>", "credential reference (e.g. op://...), never a raw secret")
  .action((agentId: string, opts: { username: string; credentialRef?: string }) => {
    try {
      linkGithub(agentId, {
        username: opts.username,
        ...(opts.credentialRef ? { credentialRef: opts.credentialRef } : {}),
      });
      console.log(`linked ${agentId} -> github:${opts.username}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

await program.parseAsync();
```

- [ ] **Step 2: Smoke-test the commands manually**

```bash
npx tsx packages/client/src/cli.ts --help
npx tsx packages/client/src/cli.ts pool status
npx tsx packages/client/src/cli.ts pool provision --count 1 --api-url https://x.invalid --fleet-key fk
```

Expected: help lists `setup`, `pool`, `github`; `pool status` prints totals; the provision command prints `failed: ...` (fetch to x.invalid fails) then `0/1 identities provisioned` and exits 1.

- [ ] **Step 3: Run the full suite (regression)**

Run: `pnpm vitest run`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/cli.ts
git commit -m "feat(client): setup, pool provision, and pool status CLI commands"
```

---

### Task 8: Publishable package (`packages/dist`)

**Files:**
- Create: `packages/dist/package.json`, `packages/dist/tsup.config.ts`, `packages/dist/tsconfig.json`, `packages/dist/src/index.ts`, `packages/dist/src/cli.ts`, `packages/dist/src/server.ts`, `packages/dist/skill/SKILL.md`, `packages/dist/README.md`
- Modify: `packages/client/package.json` (add `./cli` export), `packages/mcp/package.json` (add `./server` export), `.gitignore`

- [ ] **Step 1: Add subpath exports to the source packages**

`packages/client/package.json` — change the `exports` field to:

```json
"exports": { ".": "./src/index.ts", "./cli": "./src/cli.ts" },
```

`packages/mcp/package.json` — change the `exports` field to:

```json
"exports": { ".": "./src/tools.ts", "./server": "./src/server.ts" },
```

- [ ] **Step 2: Create the package manifest and configs**

`packages/dist/package.json`:

```json
{
  "name": "@critical-labs/agent-identity",
  "version": "0.1.0",
  "description": "Persistent, verifiable identities for AI agents: email mailbox, MCP server, session identity pool, and setup CLI",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/critical-labs/agent-identity.git" },
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "bin": {
    "agent-identity": "./dist/cli.js",
    "agent-identity-mcp": "./dist/server.js"
  },
  "files": ["dist", "skill", "README.md"],
  "engines": { "node": ">=20" },
  "scripts": { "build": "tsup" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "commander": "^12.1.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@agent-identity/client": "workspace:*",
    "@agent-identity/mcp": "workspace:*",
    "@agent-identity/shared": "workspace:*",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0"
  }
}
```

`packages/dist/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts", server: "src/server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  splitting: false,
  clean: true,
  dts: { entry: { index: "src/index.ts" } },
  noExternal: [/^@agent-identity\//],
  banner: { js: "#!/usr/bin/env node" },
});
```

`packages/dist/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 3: Create the entry points**

`packages/dist/src/index.ts`:

```ts
export * from "@agent-identity/shared";
export * from "@agent-identity/client";
```

`packages/dist/src/cli.ts`:

```ts
import "@agent-identity/client/cli";
```

`packages/dist/src/server.ts`:

```ts
import "@agent-identity/mcp/server";
```

- [ ] **Step 4: Write the bundled skill**

`packages/dist/skill/SKILL.md`:

```markdown
---
name: agent-identity
description: Use when the agent needs its own identity or email mailbox — at session start, before GitHub workflows, when onboarding a GitHub account for an agent, or when reading email sent to an agent address
---

# agent-identity

This repo has the agent-identity MCP server configured (`.mcp.json`). It gives
each session a persistent identity with a receive-only email mailbox.

## Session start

Call the `ensure_identity` MCP tool before any workflow that needs email or a
stable identity. It is idempotent and returns your `agentId` and mailbox
`address`. Before GitHub work, call it as `ensure_identity` with
`{"require": ["github"]}` to hold a GitHub-capable identity; if none is free
the error explains how to free or onboard one. `identity_status` shows what
this session holds and what is free in the machine-local pool.

## Reading email

`list_emails` (summaries, newest first), `get_email` (full body + extracted
links), `wait_for_email` (poll with `fromContains`/`subjectContains`; a
timeout returns `{timedOut: true}`, not an error). Following links is your
job — the server never fetches URLs.

## GitHub onboarding (human-assisted by design)

GitHub blocks automated signups, so onboarding an account for an identity is
a joint task:

1. You (agent): call `ensure_identity`, report the mailbox address.
2. Human: completes the GitHub signup form with that address (ToS + CAPTCHA).
3. You: `wait_for_email` with `subjectContains` matching GitHub's
   verification mail, then `get_email` and surface the verification link.
4. Operator: `mailctl agent tag <agentId> github` (in the agent-identity
   repo), then `npx agent-identity github link <agentId> --username <login>
   [--credential-ref op://...]` on this machine.

## Guiding the human

`npx agent-identity setup` re-runs repo onboarding (backend, identities,
`.mcp.json`). `npx agent-identity pool provision --count N` mints more
identities; `npx agent-identity pool status` shows availability. Suggest
these commands to the human rather than editing config by hand.
```

- [ ] **Step 5: Write the package README**

`packages/dist/README.md`:

```markdown
# @critical-labs/agent-identity

Persistent, verifiable identities for AI agents: an Ed25519 keypair per
identity, a receive-only email mailbox (`<id>@<your-domain>`), an MCP server
with session-scoped identity claiming, and a setup CLI.

## Install & set up (consuming repo)

```bash
npm install @critical-labs/agent-identity
npx agent-identity setup
```

The wizard connects to an existing backend (API URL + fleet key) or walks
you through deploying a new one, optionally provisions pool identities,
writes `.mcp.json`, and installs the Claude Code skill.

## What you get

- **`agent-identity-mcp`** — MCP server (stdio). Tools: `ensure_identity`,
  `identity_status`, `list_emails`, `get_email`, `wait_for_email`.
- **`agent-identity`** — CLI: `setup`, `pool provision --count N`,
  `pool status`, `github link`.
- **Library** — `import { AgentIdentityClient, claimFromPool } from
  "@critical-labs/agent-identity"`.

Secrets never live in `.mcp.json`: the fleet key is stored at
`~/.config/agent-identity/fleet_key` (0600) and read by the server when the
`AGENT_IDENTITY_FLEET_KEY` env var is unset.

Source, deploy stack, and operator docs:
https://github.com/critical-labs/agent-identity
```

- [ ] **Step 6: Ignore build output**

Append to `.gitignore`:

```
packages/dist/dist/
```

- [ ] **Step 7: Install, build, and smoke-test**

```bash
pnpm install
pnpm --filter @critical-labs/agent-identity build
node packages/dist/dist/cli.js --help
printf '' | timeout 10 env AGENT_IDENTITY_API_URL=https://smoke.invalid node packages/dist/dist/server.js; echo "server exit: $?"
head -1 packages/dist/dist/cli.js
```

Expected: build succeeds producing `dist/index.js`, `dist/index.d.ts`, `dist/cli.js`, `dist/server.js`; `--help` lists `setup`, `pool`, `github`; the server starts, hits its (non-fatal) init error, and exits 0 when stdin closes; the head shows `#!/usr/bin/env node`. If the server does not exit on stdin EOF, check that nothing keeps the event loop alive — the claim manager holds no timers after `init()`.

- [ ] **Step 8: Verify the publish artifact**

```bash
cd packages/dist && npm pack --dry-run && cd ../..
```

Expected: the tarball contains `dist/`, `skill/SKILL.md`, `README.md`, `package.json` — no `src/`, no `tsup.config.ts`.

- [ ] **Step 9: Run suite + typecheck**

```bash
pnpm vitest run
npx tsc --noEmit -p tsconfig.base.json
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/dist packages/client/package.json packages/mcp/package.json .gitignore pnpm-lock.yaml
git commit -m "feat: publishable @critical-labs/agent-identity package bundling mcp, client, cli, and skill"
```

---

### Task 9: Publish workflow

**Files:**
- Create: `.github/workflows/publish.yml`

Pin actions to the same SHAs used in `.github/workflows/deploy.yml` (repo convention). `pnpm publish` rewrites `workspace:*` before publishing; provenance requires `id-token: write`.

- [ ] **Step 1: Write the workflow**

```yaml
name: publish

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
        with:
          version: 9
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 20
          cache: pnpm
          registry-url: https://registry.npmjs.org
      - run: pnpm install --frozen-lockfile
      - run: pnpm vitest run
      - run: npx tsc --noEmit -p tsconfig.base.json
      - run: pnpm --filter @critical-labs/agent-identity build
      - name: Smoke-test built bins
        run: |
          node packages/dist/dist/cli.js --help > /dev/null
          printf '' | timeout 10 env AGENT_IDENTITY_API_URL=https://smoke.invalid node packages/dist/dist/server.js
      - name: Publish
        working-directory: packages/dist
        run: pnpm publish --access public --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"
```

- [ ] **Step 2: Validate the YAML**

Run: `npx yaml-lint .github/workflows/publish.yml 2>/dev/null || node -e "const yaml=require('js-yaml') ?? null" 2>/dev/null; python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: publish @critical-labs/agent-identity to npm on version tags"
```

---

### Task 10: README update

**Files:**
- Modify: `README.md` (Quick start section, lines 7-26; add packaging notes)

- [ ] **Step 1: Replace the "Quick start (agent)" section**

Replace the section body (the intro line, JSON block, and the paragraph after it — keep the `ensure_identity` paragraph) with:

````markdown
## Quick start (consuming repo)

```bash
npm install @critical-labs/agent-identity
npx agent-identity setup
```

The setup wizard connects you to an existing deployment (API URL + fleet
key) or guides a new AWS deployment step-by-step, optionally provisions
pool identities, writes the `agent-identity` entry into `.mcp.json`, and
installs the bundled Claude Code skill into `.claude/skills/`.

The fleet key is stored at `~/.config/agent-identity/fleet_key` (mode 600)
and the API URL at `~/.config/agent-identity/config.json`; `.mcp.json`
contains no secrets. The MCP server reads `AGENT_IDENTITY_FLEET_KEY` from
the environment first and falls back to the key file.

Manual MCP configuration (what the wizard writes):

```json
{
  "mcpServers": {
    "agent-identity": {
      "command": "npx",
      "args": ["agent-identity-mcp"],
      "env": { "AGENT_IDENTITY_API_URL": "https://<api-id>.execute-api.<region>.amazonaws.com" }
    }
  }
}
```

Other CLI commands: `npx agent-identity pool provision --count N` (mint
identities into the machine-local pool), `npx agent-identity pool status`,
`npx agent-identity github link <agentId> --username <login>`.
````

Keep the existing paragraph that starts "Call `ensure_identity` at the start of every session" unchanged, directly after the new content.

- [ ] **Step 2: Add a "Releasing" note at the end of the CI/CD section**

```markdown
### Releasing to npm

Bump `version` in `packages/dist/package.json`, commit, then tag and push:
`git tag v<version> && git push origin v<version>`. The publish workflow
tests, builds, smoke-tests the bins, and publishes
`@critical-labs/agent-identity` with provenance. One-time setup: create the
`critical-labs` npm org and add an automation token as the `NPM_TOKEN`
repository secret.
```

- [ ] **Step 3: Check accuracy against the code**

Re-read the section and verify every command and path matches what Tasks 1-9 built (bin names, config paths, wizard behavior, workflow trigger).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: consuming-repo quick start via npm install + setup wizard"
```

---

### Task 11: Final verification

- [ ] **Step 1: Full suite + typecheck**

```bash
pnpm vitest run
npx tsc --noEmit -p tsconfig.base.json
```

Expected: all tests pass (89 pre-existing + ~22 new), typecheck clean.

- [ ] **Step 2: End-to-end wizard dry run in a scratch repo**

```bash
SCRATCH=$(mktemp -d) && cd "$SCRATCH"
npx tsx <worktree>/packages/client/src/cli.ts setup --skill-dir <worktree>/packages/dist/skill
```

Walk the connect-path with the production API URL; answer `0` identities. Verify `.mcp.json` and `.claude/skills/agent-identity/SKILL.md` appear in the scratch dir, then `cd` back and delete it.

- [ ] **Step 3: Verify signatures and diff scope**

```bash
git log --format="%h %G? %s" origin/main..HEAD
git diff origin/main...HEAD --stat
```

Expected: every commit shows `G`; only files from this plan's File structure table changed (plus `pnpm-lock.yaml`).

- [ ] **Step 4: Final review**

Dispatch the final code-reviewer subagent over the whole branch, then finish the branch (push to the `fork` remote and PR to `critical-labs/agent-identity`, per repo convention — never the user's credentials).

---

## Post-merge operational runbook (not part of this plan's code)

1. Create the `critical-labs` npm org; add `NPM_TOKEN` secret. Tag `v0.1.0` to publish.
2. `npx agent-identity pool provision --count 6` on this machine (API URL + fleet key already configured).
3. critical-agent-zero: human switches the GitHub account's primary email to identity #1's address; an agent session confirms via `wait_for_email`; then `mailctl agent tag <id> github` and `npx agent-identity github link <id> --username critical-agent0 --credential-ref op://...`.
4. In homefree: `npm install @critical-labs/agent-identity && npx agent-identity setup`.
