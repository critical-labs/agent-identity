# agent-identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent-identity service per the approved spec (`docs/superpowers/specs/2026-07-04-agent-identity-design.md`): Ed25519 agent identities with numeric SES-backed mailboxes, receive-only, plus client, MCP server, admin CLI, and CDK infra.

**Architecture:** Serverless AWS: SES receipt rule → S3 (raw MIME) + ingest Lambda → DynamoDB single-table (agents + emails, 90-day TTL). API Gateway HTTP API → one api Lambda (Hono router) with Ed25519 request-signature auth. Client package signs requests; MCP server wraps the client; admin CLI hits DynamoDB directly.

**Tech Stack:** TypeScript (ESM), pnpm workspace, vitest, Hono, AWS SDK v3 (`lib-dynamodb`), `aws-sdk-client-mock` for tests, `mailparser`, `node:crypto` for Ed25519 (no external crypto deps), MCP TypeScript SDK, commander, AWS CDK v2.

**Conventions for all tasks:**
- Run all commands from repo root `/Users/mc/Documents/GitHub/agent-identity`.
- Tests run with `pnpm vitest run <path>` (single root vitest config).
- Commit after every green test, as author `critical-agent0 <critical-agent0@protonmail.com>` (already set in repo-local git config — do not touch git config).
- **Never push.** All work stays local until the operator says otherwise.
- ESM everywhere: every package.json has `"type": "module"`; imports use `.js` extensions for local files.

---

## File structure (target)

```
package.json                  # workspace root: scripts, devDeps (typescript, vitest, tsx)
pnpm-workspace.yaml
tsconfig.base.json
vitest.config.ts
.gitignore
packages/
  shared/src/ulid.ts          # minimal ULID (time-sortable id) — no deps
  shared/src/crypto.ts        # keypair gen, fingerprint, sign/verify, canonical string
  shared/src/types.ts         # AgentIdentity, EmailSummary, EmailFull, RegisterResponse
  client/src/profile.ts       # load-or-create keypair profile file
  client/src/client.ts        # AgentIdentityClient: register/me/listEmails/getEmail (signed fetch)
  api/src/db/agents.ts        # agents repo: registerIdempotent, getByFingerprint, getByLocalPart, revoke, verifyFleetKey
  api/src/db/emails.ts        # emails repo: putEmail, listEmails, getEmail
  api/src/auth.ts             # Hono middleware: verify signature, resolve active agent
  api/src/app.ts              # Hono app: POST /register, GET /me, GET /emails, GET /emails/:id
  api/src/lambda.ts           # Lambda handler (hono/aws-lambda)
  ingest/src/handler.ts       # SES Lambda-action handler: verdicts, lookup, parse, links, put
  ingest/src/parse.ts         # MIME → ParsedEmail (mailparser wrapper + link extraction)
  admin/src/mailctl.ts        # CLI: fleet-key create, agent list, agent revoke
  mcp/src/server.ts           # MCP stdio server: ensure_identity, list_emails, get_email, wait_for_email
infra/
  package.json, cdk.json, tsconfig.json
  bin/app.ts                  # CDK app entry (domain/region from context)
  lib/stack.ts                # Table, bucket+lifecycle, SES rule set, both Lambdas, HTTP API
docs/superpowers/specs/...    # (exists)
```

**Data model (single table, on-demand, TTL attr `expiresAt`):**
| Entity | PK | SK | Attributes |
|---|---|---|---|
| Agent | `AGENT#<fp>` | `AGENT` | agentId, publicKey (spki b64), address, status, createdAt |
| Addr mirror | `ADDR#<agentId>` | `ADDR` | fingerprint |
| Fleet key | `FLEET#<sha256(key)>` | `FLEET` | createdAt, label |
| Email | `MAILBOX#<agentId>` | `EMAIL#<ulid>` | from, subject, receivedAt, text?, html?, links, bodyS3Key?, rawS3Key, expiresAt |

**Signature scheme (all API calls):** headers `x-agent-key` (spki base64), `x-agent-timestamp` (ISO), `x-agent-signature` (base64). Signed string: `METHOD\npathWithQuery\ntimestamp\nsha256hex(body)` (empty body → hash of empty string). Skew tolerance ±300s. `POST /register` additionally sends `x-fleet-key`.

---

### Task 0: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/{shared,client,api,ingest,admin,mcp}/package.json` and empty `src/` dirs

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "agent-identity",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "tsx": "^4.16.0",
    "@types/node": "^20.14.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "infra"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["packages/*/src/**/*.test.ts"] },
});
```

`.gitignore`:
```
node_modules/
dist/
cdk.out/
*.tsbuildinfo
.env
```

- [ ] **Step 2: Package manifests**

For each package, create `packages/<name>/package.json` (adjust `name`) and `packages/<name>/tsconfig.json`. Example for `shared` (others identical apart from name and deps added in later tasks):

```json
{
  "name": "@agent-identity/shared",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Create the other five with names `@agent-identity/client`, `@agent-identity/api`, `@agent-identity/ingest`, `@agent-identity/admin`, `@agent-identity/mcp`.

- [ ] **Step 3: Install and verify**

Run: `pnpm install && pnpm vitest run`
Expected: install succeeds; vitest reports "No test files found" (exit code 1 is fine at this stage — confirm the message, not the code).

- [ ] **Step 4: Commit**

```bash
git add -A . && git commit -m "chore: scaffold pnpm workspace"
```

---

### Task 1: shared — ULID, fingerprint, sign/verify

**Files:**
- Create: `packages/shared/src/ulid.ts`, `packages/shared/src/crypto.ts`, `packages/shared/src/types.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/ulid.test.ts`, `packages/shared/src/crypto.test.ts`

- [ ] **Step 1: Write failing ULID test**

`packages/shared/src/ulid.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { encodeTime, ulid } from "./ulid.js";

describe("ulid", () => {
  it("is 26 chars of Crockford base32", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("sorts by time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a < b).toBe(true);
  });
  it("encodeTime is deterministic 10-char prefix", () => {
    expect(encodeTime(0)).toBe("0000000000");
    expect(ulid(123456789).startsWith(encodeTime(123456789))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/shared/src/ulid.test.ts`
Expected: FAIL — cannot resolve `./ulid.js`.

- [ ] **Step 3: Implement**

`packages/shared/src/ulid.ts`:
```ts
import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeTime(ms: number): string {
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = B32[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

export function ulid(ms: number = Date.now()): string {
  const rand = randomBytes(16);
  let out = encodeTime(ms);
  for (let i = 0; i < 16; i++) out += B32[rand[i] % 32];
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/shared/src/ulid.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write failing crypto test**

`packages/shared/src/crypto.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  canonicalString, fingerprint, generateKeypair, sign, verify,
} from "./crypto.js";

describe("crypto", () => {
  it("round-trips sign/verify with generated keypair", () => {
    const kp = generateKeypair();
    const msg = canonicalString("GET", "/emails?limit=5", "2026-07-04T00:00:00Z", "");
    const sig = sign(msg, kp.privateKeyPem);
    expect(verify(msg, sig, kp.publicKeySpkiBase64)).toBe(true);
    expect(verify(msg + "x", sig, kp.publicKeySpkiBase64)).toBe(false);
  });
  it("fingerprint is stable 64-hex of the public key", () => {
    const kp = generateKeypair();
    const fp = fingerprint(kp.publicKeySpkiBase64);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(kp.publicKeySpkiBase64)).toBe(fp);
  });
  it("canonicalString hashes the body", () => {
    const a = canonicalString("POST", "/register", "t", "");
    const b = canonicalString("POST", "/register", "t", "{}");
    expect(a).not.toBe(b);
    expect(a.split("\n")).toHaveLength(4);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm vitest run packages/shared/src/crypto.test.ts`
Expected: FAIL — cannot resolve `./crypto.js`.

- [ ] **Step 7: Implement**

`packages/shared/src/crypto.ts`:
```ts
import {
  createHash, createPrivateKey, createPublicKey,
  generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify,
} from "node:crypto";

export interface Keypair {
  privateKeyPem: string;
  publicKeySpkiBase64: string;
}

export function generateKeypair(): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

export function fingerprint(publicKeySpkiBase64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeySpkiBase64, "base64")).digest("hex");
}

export function canonicalString(
  method: string, pathWithQuery: string, timestamp: string, body: string,
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`;
}

export function sign(message: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, Buffer.from(message), key).toString("base64");
}

export function verify(
  message: string, signatureBase64: string, publicKeySpkiBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, "base64"), format: "der", type: "spki",
    });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
```

`packages/shared/src/types.ts`:
```ts
export interface AgentIdentity {
  agentId: string;        // numeric string, e.g. "482913"
  address: string;        // "482913@mail.example.com"
}

export interface EmailSummary {
  id: string;             // ULID
  from: string;
  subject: string;
  receivedAt: string;     // ISO
}

export interface EmailFull extends EmailSummary {
  text: string;
  html?: string;
  links: string[];
}

export interface RegisterResponse extends AgentIdentity {}
```

`packages/shared/src/index.ts`:
```ts
export * from "./ulid.js";
export * from "./crypto.js";
export * from "./types.js";
```

- [ ] **Step 8: Run to verify pass**

Run: `pnpm vitest run packages/shared`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): ulid, ed25519 signing, canonical request string"
```

---

### Task 2: client — keypair profile store

**Files:**
- Create: `packages/client/src/profile.ts`
- Test: `packages/client/src/profile.test.ts`
- Modify: `packages/client/package.json` (add dep `@agent-identity/shared`: `"workspace:*"`)

- [ ] **Step 1: Add workspace dep**

In `packages/client/package.json` add:
```json
"dependencies": { "@agent-identity/shared": "workspace:*" }
```
Run: `pnpm install`

- [ ] **Step 2: Write failing test**

`packages/client/src/profile.test.ts`:
```ts
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateProfile } from "./profile.js";

describe("profile", () => {
  it("creates a keypair file with mode 0600, then reloads the same keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "aid-"));
    const p1 = loadOrCreateProfile("default", dir);
    const p2 = loadOrCreateProfile("default", dir);
    expect(p1.publicKeySpkiBase64).toBe(p2.publicKeySpkiBase64);
    const mode = statSync(join(dir, "default.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
  it("different profiles get different keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "aid-"));
    const a = loadOrCreateProfile("a", dir);
    const b = loadOrCreateProfile("b", dir);
    expect(a.publicKeySpkiBase64).not.toBe(b.publicKeySpkiBase64);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/client`
Expected: FAIL — cannot resolve `./profile.js`.

- [ ] **Step 4: Implement**

`packages/client/src/profile.ts`:
```ts
import { generateKeypair, type Keypair } from "@agent-identity/shared";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Profile extends Keypair {
  agentId?: string;
  address?: string;
}

export function defaultProfileDir(): string {
  return join(homedir(), ".config", "agent-identity");
}

export function loadOrCreateProfile(
  name: string = process.env.AGENT_IDENTITY_PROFILE ?? "default",
  dir: string = defaultProfileDir(),
): Profile {
  const file = join(dir, `${name}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Profile;
  } catch {
    mkdirSync(dir, { recursive: true });
    const profile: Profile = generateKeypair();
    writeFileSync(file, JSON.stringify(profile, null, 2), { mode: 0o600 });
    return profile;
  }
}

export function saveProfile(
  profile: Profile,
  name: string = process.env.AGENT_IDENTITY_PROFILE ?? "default",
  dir: string = defaultProfileDir(),
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(profile, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/client`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/client && git commit -m "feat(client): keypair profile store with 0600 perms"
```

---

### Task 3: api — agents repo (idempotent register, lookups, revoke, fleet key)

**Files:**
- Create: `packages/api/src/db/agents.ts`
- Test: `packages/api/src/db/agents.test.ts`
- Modify: `packages/api/package.json`

- [ ] **Step 1: Add deps**

In `packages/api/package.json`:
```json
"dependencies": {
  "@agent-identity/shared": "workspace:*",
  "@aws-sdk/client-dynamodb": "^3.600.0",
  "@aws-sdk/lib-dynamodb": "^3.600.0",
  "hono": "^4.5.0"
},
"devDependencies": { "aws-sdk-client-mock": "^4.0.0" }
```
Run: `pnpm install`

- [ ] **Step 2: Write failing test**

`packages/api/src/db/agents.test.ts`:
```ts
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentsRepo } from "./agents.js";

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new AgentsRepo(ddb as never, "tbl", "mail.example.com");

beforeEach(() => ddb.reset());

describe("AgentsRepo.register", () => {
  it("returns existing identity when fingerprint already registered", async () => {
    ddb.on(GetCommand).resolves({
      Item: { agentId: "482913", address: "482913@mail.example.com", status: "active" },
    });
    const res = await repo.register("PUBKEY", "fp1");
    expect(res).toEqual({ agentId: "482913", address: "482913@mail.example.com" });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("creates agent + addr mirror transactionally when new", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    const res = await repo.register("PUBKEY", "fp1");
    expect(res.agentId).toMatch(/^\d{6}$/);
    expect(res.address).toBe(`${res.agentId}@mail.example.com`);
    const tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(tx.TransactItems).toHaveLength(2);
  });

  it("retries with a new numeric id on address collision", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand)
      .rejectsOnce(Object.assign(new Error("x"), { name: "TransactionCanceledException" }))
      .resolves({});
    const res = await repo.register("PUBKEY", "fp1");
    expect(res.agentId).toMatch(/^\d{6}$/);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });
});

describe("AgentsRepo lookups", () => {
  it("getByLocalPart resolves mirror then agent", async () => {
    ddb.on(GetCommand, { TableName: "tbl", Key: { PK: "ADDR#482913", SK: "ADDR" } })
      .resolves({ Item: { fingerprint: "fp1" } });
    ddb.on(GetCommand, { TableName: "tbl", Key: { PK: "AGENT#fp1", SK: "AGENT" } })
      .resolves({ Item: { agentId: "482913", status: "active" } });
    const agent = await repo.getByLocalPart("482913");
    expect(agent?.agentId).toBe("482913");
  });

  it("verifyFleetKey hashes and checks existence", async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: "FLEET#abc" } });
    expect(await repo.verifyFleetKey("secret")).toBe(true);
    ddb.on(GetCommand).resolves({});
    expect(await repo.verifyFleetKey("secret")).toBe(false);
  });

  it("revoke sets status=revoked", async () => {
    ddb.on(UpdateCommand).resolves({});
    await repo.revoke("fp1");
    const call = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(call.Key).toEqual({ PK: "AGENT#fp1", SK: "AGENT" });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/api/src/db/agents.test.ts`
Expected: FAIL — cannot resolve `./agents.js`.

- [ ] **Step 4: Implement**

`packages/api/src/db/agents.ts`:
```ts
import type { AgentIdentity } from "@agent-identity/shared";
import {
  DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomInt } from "node:crypto";

export interface AgentRecord extends AgentIdentity {
  publicKey: string;
  status: "active" | "revoked";
  createdAt: string;
}

export class AgentsRepo {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly domain: string,
  ) {}

  async getByFingerprint(fp: string): Promise<AgentRecord | undefined> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `AGENT#${fp}`, SK: "AGENT" },
    }));
    return Item as AgentRecord | undefined;
  }

  async getByLocalPart(agentId: string): Promise<AgentRecord | undefined> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `ADDR#${agentId}`, SK: "ADDR" },
    }));
    if (!Item) return undefined;
    return this.getByFingerprint(Item.fingerprint as string);
  }

  async register(publicKeySpkiBase64: string, fp: string): Promise<AgentIdentity> {
    const existing = await this.getByFingerprint(fp);
    if (existing) return { agentId: existing.agentId, address: existing.address };

    for (let attempt = 0; attempt < 5; attempt++) {
      const agentId = String(randomInt(100000, 1000000));
      const address = `${agentId}@${this.domain}`;
      try {
        await this.ddb.send(new TransactWriteCommand({
          TransactItems: [
            { Put: {
              TableName: this.table,
              Item: { PK: `ADDR#${agentId}`, SK: "ADDR", fingerprint: fp },
              ConditionExpression: "attribute_not_exists(PK)",
            }},
            { Put: {
              TableName: this.table,
              Item: {
                PK: `AGENT#${fp}`, SK: "AGENT", agentId, address,
                publicKey: publicKeySpkiBase64, status: "active",
                createdAt: new Date().toISOString(),
              },
              ConditionExpression: "attribute_not_exists(PK)",
            }},
          ],
        }));
        return { agentId, address };
      } catch (err) {
        if ((err as Error).name !== "TransactionCanceledException") throw err;
        // Either addr collision (retry new id) or concurrent register of the
        // same key (return what won).
        const winner = await this.getByFingerprint(fp);
        if (winner) return { agentId: winner.agentId, address: winner.address };
      }
    }
    throw new Error("could not allocate agent id after 5 attempts");
  }

  async verifyFleetKey(fleetKey: string): Promise<boolean> {
    const hash = createHash("sha256").update(fleetKey).digest("hex");
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `FLEET#${hash}`, SK: "FLEET" },
    }));
    return Item !== undefined;
  }

  async revoke(fp: string): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: this.table,
      Key: { PK: `AGENT#${fp}`, SK: "AGENT" },
      UpdateExpression: "SET #s = :r",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":r": "revoked" },
    }));
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/api/src/db/agents.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api && git commit -m "feat(api): agents repo with idempotent registration and fleet keys"
```

---

### Task 4: api — emails repo

**Files:**
- Create: `packages/api/src/db/emails.ts`
- Test: `packages/api/src/db/emails.test.ts`

- [ ] **Step 1: Write failing test**

`packages/api/src/db/emails.test.ts`:
```ts
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailsRepo } from "./emails.js";

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new EmailsRepo(ddb as never, "tbl", 90);

beforeEach(() => ddb.reset());

describe("EmailsRepo", () => {
  it("putEmail writes MAILBOX partition with 90-day TTL", async () => {
    ddb.on(PutCommand).resolves({});
    const id = await repo.putEmail("482913", {
      from: "noreply@github.com", subject: "Verify",
      receivedAt: "2026-07-04T10:00:00.000Z",
      text: "hi", links: ["https://github.com/v"], rawS3Key: "raw/m1",
    });
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe("MAILBOX#482913");
    expect(item.SK).toBe(`EMAIL#${id}`);
    const ttlDelta = (item.expiresAt as number) - Date.parse("2026-07-04T10:00:00Z") / 1000;
    expect(ttlDelta).toBe(90 * 24 * 3600);
  });

  it("listEmails queries newest-first and maps summaries", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [{ SK: "EMAIL#01ABC", from: "a@b.c", subject: "s", receivedAt: "t" }],
    });
    const { emails } = await repo.listEmails("482913", {});
    expect(emails).toEqual([{ id: "01ABC", from: "a@b.c", subject: "s", receivedAt: "t" }]);
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ScanIndexForward).toBe(false);
  });

  it("listEmails applies since as SK lower bound", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await repo.listEmails("482913", { since: "2026-07-04T00:00:00Z" });
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.KeyConditionExpression).toContain(":sk");
  });

  it("getEmail returns undefined for another agent's email", async () => {
    ddb.on(GetCommand).resolves({});
    expect(await repo.getEmail("482913", "01ABC")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/api/src/db/emails.test.ts`
Expected: FAIL — cannot resolve `./emails.js`.

- [ ] **Step 3: Implement**

`packages/api/src/db/emails.ts`:
```ts
import { encodeTime, ulid, type EmailFull, type EmailSummary } from "@agent-identity/shared";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
} from "@aws-sdk/lib-dynamodb";

export interface NewEmail {
  from: string;
  subject: string;
  receivedAt: string;
  text?: string;
  html?: string;
  links: string[];
  rawS3Key: string;
  bodyS3Key?: string;
}

export class EmailsRepo {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly retentionDays: number,
  ) {}

  async putEmail(agentId: string, email: NewEmail): Promise<string> {
    const id = ulid(Date.parse(email.receivedAt));
    const expiresAt =
      Math.floor(Date.parse(email.receivedAt) / 1000) + this.retentionDays * 24 * 3600;
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: { PK: `MAILBOX#${agentId}`, SK: `EMAIL#${id}`, expiresAt, ...email },
    }));
    return id;
  }

  async listEmails(
    agentId: string,
    opts: { since?: string; limit?: number; cursor?: string },
  ): Promise<{ emails: EmailSummary[]; cursor?: string }> {
    const cond = opts.since ? "PK = :pk AND SK >= :sk" : "PK = :pk AND begins_with(SK, :pfx)";
    const values: Record<string, string> = { ":pk": `MAILBOX#${agentId}` };
    if (opts.since) values[":sk"] = `EMAIL#${encodeTime(Date.parse(opts.since))}`;
    else values[":pfx"] = "EMAIL#";
    const res = await this.ddb.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: cond,
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
      Limit: opts.limit ?? 25,
      ExclusiveStartKey: opts.cursor
        ? JSON.parse(Buffer.from(opts.cursor, "base64url").toString())
        : undefined,
    }));
    return {
      emails: (res.Items ?? []).map((i) => ({
        id: (i.SK as string).slice("EMAIL#".length),
        from: i.from as string,
        subject: i.subject as string,
        receivedAt: i.receivedAt as string,
      })),
      cursor: res.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64url")
        : undefined,
    };
  }

  async getEmail(agentId: string, id: string): Promise<(EmailFull & { bodyS3Key?: string }) | undefined> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `MAILBOX#${agentId}`, SK: `EMAIL#${id}` },
    }));
    if (!Item) return undefined;
    return {
      id,
      from: Item.from as string,
      subject: Item.subject as string,
      receivedAt: Item.receivedAt as string,
      text: (Item.text as string) ?? "",
      html: Item.html as string | undefined,
      links: (Item.links as string[]) ?? [],
      bodyS3Key: Item.bodyS3Key as string | undefined,
    };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/api/src/db/emails.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api && git commit -m "feat(api): emails repo with TTL, since-bound and cursor pagination"
```

---

### Task 5: api — signature auth middleware

**Files:**
- Create: `packages/api/src/auth.ts`
- Test: `packages/api/src/auth.test.ts`

- [ ] **Step 1: Write failing test**

`packages/api/src/auth.test.ts`:
```ts
import { canonicalString, fingerprint, generateKeypair, sign } from "@agent-identity/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { signatureAuth } from "./auth.js";
import type { AgentsRepo } from "./db/agents.js";

function makeApp(repo: Partial<AgentsRepo>) {
  const app = new Hono();
  app.use("*", signatureAuth(repo as AgentsRepo));
  app.get("/me", (c) => c.json(c.get("agent" as never)));
  return app;
}

function signedHeaders(kp: ReturnType<typeof generateKeypair>, path: string, ts?: string) {
  const timestamp = ts ?? new Date().toISOString();
  return {
    "x-agent-key": kp.publicKeySpkiBase64,
    "x-agent-timestamp": timestamp,
    "x-agent-signature": sign(canonicalString("GET", path, timestamp, ""), kp.privateKeyPem),
  };
}

describe("signatureAuth", () => {
  const kp = generateKeypair();
  const fp = fingerprint(kp.publicKeySpkiBase64);
  const agent = { agentId: "1", address: "1@d", status: "active", publicKey: kp.publicKeySpkiBase64 };

  it("accepts a valid signature for an active agent", async () => {
    const app = makeApp({ getByFingerprint: vi.fn(async (f) => (f === fp ? agent : undefined)) as never });
    const res = await app.request("/me", { headers: signedHeaders(kp, "/me") });
    expect(res.status).toBe(200);
  });

  it("rejects bad signature with 401", async () => {
    const app = makeApp({ getByFingerprint: vi.fn(async () => agent) as never });
    const h = signedHeaders(kp, "/other-path");
    const res = await app.request("/me", { headers: h });
    expect(res.status).toBe(401);
  });

  it("rejects stale timestamp with 401", async () => {
    const app = makeApp({ getByFingerprint: vi.fn(async () => agent) as never });
    const res = await app.request("/me", {
      headers: signedHeaders(kp, "/me", "2020-01-01T00:00:00.000Z"),
    });
    expect(res.status).toBe(401);
  });

  it("rejects revoked agent with 403", async () => {
    const app = makeApp({
      getByFingerprint: vi.fn(async () => ({ ...agent, status: "revoked" })) as never,
    });
    const res = await app.request("/me", { headers: signedHeaders(kp, "/me") });
    expect(res.status).toBe(403);
  });

  it("rejects unknown key with 401 (except /register, which passes through)", async () => {
    const app = makeApp({ getByFingerprint: vi.fn(async () => undefined) as never });
    const res = await app.request("/me", { headers: signedHeaders(kp, "/me") });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/api/src/auth.test.ts`
Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Implement**

`packages/api/src/auth.ts`:
```ts
import { canonicalString, fingerprint, verify } from "@agent-identity/shared";
import type { MiddlewareHandler } from "hono";
import type { AgentRecord, AgentsRepo } from "./db/agents.js";

const SKEW_MS = 300_000;

declare module "hono" {
  interface ContextVariableMap {
    agent: AgentRecord;
    verifiedPublicKey: string;
  }
}

export function signatureAuth(agents: AgentsRepo): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header("x-agent-key");
    const ts = c.req.header("x-agent-timestamp");
    const sig = c.req.header("x-agent-signature");
    if (!key || !ts || !sig) return c.json({ error: "missing auth headers" }, 401);

    if (Math.abs(Date.now() - Date.parse(ts)) > SKEW_MS)
      return c.json({ error: "timestamp out of range" }, 401);

    const url = new URL(c.req.url);
    const pathWithQuery = url.pathname + url.search;
    const body = await c.req.raw.clone().text();
    const message = canonicalString(c.req.method, pathWithQuery, ts, body);
    if (!verify(message, sig, key)) return c.json({ error: "invalid signature" }, 401);

    c.set("verifiedPublicKey", key);

    // /register is the only route allowed before an agent record exists;
    // signature possession is proven above, fleet key is checked in the route.
    if (c.req.method === "POST" && url.pathname === "/register") return next();

    const agent = await agents.getByFingerprint(fingerprint(key));
    if (!agent) return c.json({ error: "unknown agent" }, 401);
    if (agent.status !== "active") return c.json({ error: "revoked" }, 403);
    c.set("agent", agent);
    return next();
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/api/src/auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api && git commit -m "feat(api): ed25519 signature auth middleware with skew + revocation checks"
```

---

### Task 6: api — routes and Lambda handler

**Files:**
- Create: `packages/api/src/app.ts`, `packages/api/src/lambda.ts`
- Test: `packages/api/src/app.test.ts`
- Modify: `packages/api/package.json` (add `"@aws-sdk/client-s3": "^3.600.0"`)

- [ ] **Step 1: Add S3 dep**

Add `"@aws-sdk/client-s3": "^3.600.0"` to `packages/api/package.json` dependencies. Run `pnpm install`.

- [ ] **Step 2: Write failing test**

`packages/api/src/app.test.ts`:
```ts
import { canonicalString, generateKeypair, sign } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "./app.js";

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

const agent = { agentId: "482913", address: "482913@d", status: "active" as const, publicKey: kp.publicKeySpkiBase64, createdAt: "t" };

function makeDeps(overrides: Partial<Deps["agents"] & Deps["emails"]> = {}): Deps {
  return {
    agents: {
      getByFingerprint: vi.fn(async () => agent),
      register: vi.fn(async () => ({ agentId: "482913", address: "482913@d" })),
      verifyFleetKey: vi.fn(async () => true),
      ...overrides,
    } as never,
    emails: {
      listEmails: vi.fn(async () => ({ emails: [] })),
      getEmail: vi.fn(async () => undefined),
      ...overrides,
    } as never,
    readBody: vi.fn(async () => ({ text: "overflow", html: undefined, links: [] })),
    fleetKeyRequired: true,
  };
}

describe("app", () => {
  it("POST /register verifies fleet key and registers", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const req = signed("POST", "/register");
    const res = await app.request("/register", {
      ...req, headers: { ...req.headers, "x-fleet-key": "fk" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: "482913", address: "482913@d" });
  });

  it("POST /register without fleet key is 403", async () => {
    const deps = makeDeps({ verifyFleetKey: vi.fn(async () => false) as never });
    const app = createApp(deps);
    const res = await app.request("/register", signed("POST", "/register"));
    expect(res.status).toBe(403);
  });

  it("GET /me returns caller identity", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/me", signed("GET", "/me"));
    expect(await res.json()).toEqual({ agentId: "482913", address: "482913@d" });
  });

  it("GET /emails passes since/limit and scopes to caller", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const path = "/emails?since=2026-07-01T00:00:00Z&limit=5";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(200);
    expect(deps.emails.listEmails).toHaveBeenCalledWith("482913", {
      since: "2026-07-01T00:00:00Z", limit: 5, cursor: undefined,
    });
  });

  it("GET /emails/:id 404s on missing/foreign email", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/emails/01ABC", signed("GET", "/emails/01ABC"));
    expect(res.status).toBe(404);
  });

  it("GET /emails/:id reads through bodyS3Key overflow", async () => {
    const deps = makeDeps({
      getEmail: vi.fn(async () => ({
        id: "01ABC", from: "a", subject: "s", receivedAt: "t",
        text: "", links: [], bodyS3Key: "bodies/482913/01ABC.json",
      })) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/emails/01ABC", signed("GET", "/emails/01ABC"));
    const body = await res.json();
    expect(body.text).toBe("overflow");
    expect(deps.readBody).toHaveBeenCalledWith("bodies/482913/01ABC.json");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/api/src/app.test.ts`
Expected: FAIL — cannot resolve `./app.js`.

- [ ] **Step 4: Implement**

`packages/api/src/app.ts`:
```ts
import { fingerprint } from "@agent-identity/shared";
import { Hono } from "hono";
import { signatureAuth } from "./auth.js";
import type { AgentsRepo } from "./db/agents.js";
import type { EmailsRepo } from "./db/emails.js";

export interface Deps {
  agents: AgentsRepo;
  emails: EmailsRepo;
  readBody: (s3Key: string) => Promise<{ text: string; html?: string; links: string[] }>;
  fleetKeyRequired: boolean;
}

export function createApp(deps: Deps): Hono {
  const app = new Hono();
  app.use("*", signatureAuth(deps.agents));

  app.post("/register", async (c) => {
    if (deps.fleetKeyRequired) {
      const fleetKey = c.req.header("x-fleet-key");
      if (!fleetKey || !(await deps.agents.verifyFleetKey(fleetKey)))
        return c.json({ error: "invalid fleet key" }, 403);
    }
    const publicKey = c.get("verifiedPublicKey");
    const identity = await deps.agents.register(publicKey, fingerprint(publicKey));
    return c.json(identity);
  });

  app.get("/me", (c) => {
    const { agentId, address } = c.get("agent");
    return c.json({ agentId, address });
  });

  app.get("/emails", async (c) => {
    const limitRaw = c.req.query("limit");
    const result = await deps.emails.listEmails(c.get("agent").agentId, {
      since: c.req.query("since"),
      limit: limitRaw ? Number(limitRaw) : undefined,
      cursor: c.req.query("cursor"),
    });
    return c.json(result);
  });

  app.get("/emails/:id", async (c) => {
    const email = await deps.emails.getEmail(c.get("agent").agentId, c.req.param("id"));
    if (!email) return c.json({ error: "not found" }, 404);
    const { bodyS3Key, ...rest } = email;
    if (bodyS3Key) {
      const body = await deps.readBody(bodyS3Key);
      return c.json({ ...rest, ...body });
    }
    return c.json(rest);
  });

  return app;
}
```

`packages/api/src/lambda.ts`:
```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { AgentsRepo } from "./db/agents.js";
import { EmailsRepo } from "./db/emails.js";

const table = process.env.TABLE_NAME!;
const domain = process.env.MAIL_DOMAIN!;
const bucket = process.env.BUCKET_NAME!;
const retentionDays = Number(process.env.RETENTION_DAYS ?? "90");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const app = createApp({
  agents: new AgentsRepo(ddb, table, domain),
  emails: new EmailsRepo(ddb, table, retentionDays),
  readBody: async (key) => {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await res.Body!.transformToString());
  },
  fleetKeyRequired: process.env.FLEET_KEY_REQUIRED !== "false",
});

export const handler = handle(app);
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/api`
Expected: PASS (all api tests: agents 6, emails 4, auth 5, app 6).

- [ ] **Step 6: Commit**

```bash
git add packages/api && git commit -m "feat(api): hono routes, register/me/emails, lambda entry"
```

---

### Task 7: ingest — MIME parsing and SES handler

**Files:**
- Create: `packages/ingest/src/parse.ts`, `packages/ingest/src/handler.ts`
- Test: `packages/ingest/src/parse.test.ts`, `packages/ingest/src/handler.test.ts`
- Modify: `packages/ingest/package.json`

- [ ] **Step 1: Add deps**

`packages/ingest/package.json`:
```json
"dependencies": {
  "@agent-identity/api": "workspace:*",
  "@agent-identity/shared": "workspace:*",
  "@aws-sdk/client-dynamodb": "^3.600.0",
  "@aws-sdk/client-s3": "^3.600.0",
  "@aws-sdk/lib-dynamodb": "^3.600.0",
  "mailparser": "^3.7.0"
},
"devDependencies": {
  "@types/aws-lambda": "^8.10.140",
  "@types/mailparser": "^3.4.4",
  "aws-sdk-client-mock": "^4.0.0"
}
```
Run: `pnpm install`

(Reusing `AgentsRepo`/`EmailsRepo` from `@agent-identity/api` keeps the data
model in one place — add `"./db": "./src/db/index.ts"` style export only if
needed; simplest is adding to api's package.json exports:
`".": "./src/index.ts"` plus `packages/api/src/index.ts` re-exporting
`./db/agents.js` and `./db/emails.js`.)

- [ ] **Step 2: Write failing parse test**

`packages/ingest/src/parse.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { extractLinks, parseEmail } from "./parse.js";

const RAW = Buffer.from([
  "From: GitHub <noreply@github.com>",
  "To: 482913@mail.example.com",
  "Subject: Please verify",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Hi. <a href="https://github.com/verify?t=abc">Verify</a> or visit https://github.com/help</p>',
].join("\r\n"));

describe("parseEmail", () => {
  it("extracts from, subject, text, html and links", async () => {
    const parsed = await parseEmail(RAW);
    expect(parsed.from).toContain("noreply@github.com");
    expect(parsed.subject).toBe("Please verify");
    expect(parsed.links).toContain("https://github.com/verify?t=abc");
    expect(parsed.links).toContain("https://github.com/help");
    expect(parsed.text).toContain("Hi.");
  });
});

describe("extractLinks", () => {
  it("dedupes and strips trailing punctuation", () => {
    const links = extractLinks(
      "see https://a.example/x. and https://a.example/x",
      '<a href="https://b.example/y">y</a>',
    );
    expect(links).toEqual(["https://a.example/x", "https://b.example/y"]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/ingest/src/parse.test.ts`
Expected: FAIL — cannot resolve `./parse.js`.

- [ ] **Step 4: Implement parse**

`packages/ingest/src/parse.ts`:
```ts
import { simpleParser } from "mailparser";

export interface ParsedEmail {
  from: string;
  subject: string;
  text: string;
  html?: string;
  links: string[];
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export function extractLinks(text: string, html?: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_RE)) found.add(m[0].replace(/[.,;:]+$/, ""));
  if (html) {
    for (const m of html.matchAll(/href="([^"]+)"/g))
      if (m[1].startsWith("http")) found.add(m[1]);
    for (const m of html.matchAll(URL_RE)) found.add(m[0].replace(/[.,;:]+$/, ""));
  }
  // href-extracted links win over regex duplicates; Set preserves insert order
  return [...found].filter((l, _, arr) => !arr.some((o) => o !== l && o.startsWith(l + '"')));
}

export async function parseEmail(raw: Buffer): Promise<ParsedEmail> {
  const mail = await simpleParser(raw);
  const text = mail.text ?? "";
  const html = typeof mail.html === "string" ? mail.html : undefined;
  return {
    from: mail.from?.text ?? "",
    subject: mail.subject ?? "",
    text,
    html,
    links: extractLinks(text, html),
  };
}
```

Note for the implementer: if the dedupe test fails on ordering or the
trailing-quote filter, simplify `extractLinks` until the test passes — the
contract is the test, not this exact body.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/ingest/src/parse.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write failing handler test**

`packages/ingest/src/handler.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { processRecord, type IngestDeps } from "./handler.js";

const sesRecord = (over: Record<string, unknown> = {}) => ({
  ses: {
    mail: { messageId: "m1", timestamp: "2026-07-04T10:00:00.000Z" },
    receipt: {
      recipients: ["482913@mail.example.com"],
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
      ...over,
    },
  },
});

function makeDeps(): IngestDeps {
  return {
    getRaw: vi.fn(async () => Buffer.from(
      "From: a@b.c\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello https://x.example/1",
    )),
    putBodyOverflow: vi.fn(async () => "bodies/482913/X.json"),
    agents: { getByLocalPart: vi.fn(async (id: string) =>
      id === "482913" ? { agentId: "482913", status: "active" } : undefined,
    )} as never,
    emails: { putEmail: vi.fn(async () => "01ABC") } as never,
    maxInlineBodyBytes: 300_000,
  };
}

describe("processRecord", () => {
  it("stores parsed email for a known recipient", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord() as never, deps);
    expect(deps.emails.putEmail).toHaveBeenCalledWith("482913", expect.objectContaining({
      from: expect.stringContaining("a@b.c"),
      subject: "s",
      receivedAt: "2026-07-04T10:00:00.000Z",
      links: ["https://x.example/1"],
      rawS3Key: "raw/m1",
    }));
  });

  it("drops spam", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord({ spamVerdict: { status: "FAIL" } }) as never, deps);
    expect(deps.emails.putEmail).not.toHaveBeenCalled();
  });

  it("drops unknown recipients", async () => {
    const deps = makeDeps();
    const rec = sesRecord({ recipients: ["999999@mail.example.com"] });
    await processRecord(rec as never, deps);
    expect(deps.emails.putEmail).not.toHaveBeenCalled();
  });

  it("offloads oversized bodies to S3", async () => {
    const deps = { ...makeDeps(), maxInlineBodyBytes: 4 };
    await processRecord(sesRecord() as never, deps);
    expect(deps.putBodyOverflow).toHaveBeenCalled();
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.bodyS3Key).toBe("bodies/482913/X.json");
    expect(stored.text).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `pnpm vitest run packages/ingest/src/handler.test.ts`
Expected: FAIL — cannot resolve `./handler.js`.

- [ ] **Step 8: Implement handler**

`packages/ingest/src/handler.ts`:
```ts
import type { AgentsRepo, EmailsRepo } from "@agent-identity/api";
import type { SESEventRecord } from "aws-lambda";
import { parseEmail } from "./parse.js";

export interface IngestDeps {
  getRaw: (s3Key: string) => Promise<Buffer>;
  putBodyOverflow: (agentId: string, emailId: string, body: object) => Promise<string>;
  agents: Pick<AgentsRepo, "getByLocalPart">;
  emails: Pick<EmailsRepo, "putEmail">;
  maxInlineBodyBytes: number;
}

export async function processRecord(record: SESEventRecord, deps: IngestDeps): Promise<void> {
  const { mail, receipt } = record.ses;
  if (receipt.spamVerdict.status === "FAIL" || receipt.virusVerdict.status === "FAIL") return;

  const rawS3Key = `raw/${mail.messageId}`;
  let parsed: Awaited<ReturnType<typeof parseEmail>> | undefined;

  for (const recipient of receipt.recipients) {
    const localPart = recipient.split("@")[0];
    const agent = await deps.agents.getByLocalPart(localPart);
    if (!agent || agent.status !== "active") continue;

    parsed ??= await parseEmail(await deps.getRaw(rawS3Key));
    const bodySize = Buffer.byteLength(parsed.text) + Buffer.byteLength(parsed.html ?? "");
    const base = {
      from: parsed.from, subject: parsed.subject,
      receivedAt: mail.timestamp, links: parsed.links, rawS3Key,
    };
    if (bodySize > deps.maxInlineBodyBytes) {
      const bodyS3Key = await deps.putBodyOverflow(agent.agentId, mail.messageId, {
        text: parsed.text, html: parsed.html, links: parsed.links,
      });
      await deps.emails.putEmail(agent.agentId, { ...base, bodyS3Key });
    } else {
      await deps.emails.putEmail(agent.agentId, {
        ...base, text: parsed.text, html: parsed.html,
      });
    }
  }
}
```

Append the Lambda entry to the same file:
```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AgentsRepo, EmailsRepo } from "@agent-identity/api";
import type { SESEvent } from "aws-lambda";

export function makeLambdaDeps(): IngestDeps {
  const table = process.env.TABLE_NAME!;
  const bucket = process.env.BUCKET_NAME!;
  const domain = process.env.MAIL_DOMAIN!;
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = new S3Client({});
  return {
    getRaw: async (key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
    putBodyOverflow: async (agentId, emailId, body) => {
      const key = `bodies/${agentId}/${emailId}.json`;
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: JSON.stringify(body),
        ContentType: "application/json",
      }));
      return key;
    },
    agents: new AgentsRepo(ddb, table, domain),
    emails: new EmailsRepo(ddb, table, Number(process.env.RETENTION_DAYS ?? "90")),
    maxInlineBodyBytes: 300_000,
  };
}

export async function handler(event: SESEvent): Promise<void> {
  const deps = makeLambdaDeps();
  for (const record of event.Records) await processRecord(record, deps);
}
```

Also create `packages/api/src/index.ts` (if not already present from Step 1's note):
```ts
export { AgentsRepo, type AgentRecord } from "./db/agents.js";
export { EmailsRepo, type NewEmail } from "./db/emails.js";
export { createApp, type Deps } from "./app.js";
```

- [ ] **Step 9: Run to verify pass**

Run: `pnpm vitest run packages/ingest`
Expected: PASS (6 tests).

- [ ] **Step 10: Commit**

```bash
git add packages/ingest packages/api && git commit -m "feat(ingest): SES handler with verdict filter, link extraction, body overflow"
```

---

### Task 8: client — AgentIdentityClient (signed fetch)

**Files:**
- Create: `packages/client/src/client.ts`, `packages/client/src/index.ts`
- Test: `packages/client/src/client.test.ts`

- [ ] **Step 1: Write failing test**

`packages/client/src/client.test.ts`:
```ts
import { canonicalString, generateKeypair, verify } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentIdentityClient } from "./client.js";

const kp = generateKeypair();

function makeFetch(response: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
}

describe("AgentIdentityClient", () => {
  it("signs GET requests verifiably (path includes query)", async () => {
    const fetchMock = makeFetch({ emails: [] });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await client.listEmails({ limit: 5 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/emails?limit=5");
    const h = new Headers(init.headers);
    const msg = canonicalString("GET", "/emails?limit=5", h.get("x-agent-timestamp")!, "");
    expect(verify(msg, h.get("x-agent-signature")!, kp.publicKeySpkiBase64)).toBe(true);
  });

  it("register sends fleet key header and returns identity", async () => {
    const fetchMock = makeFetch({ agentId: "482913", address: "482913@d" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fleetKey: "fk", fetch: fetchMock as never,
    });
    const id = await client.register();
    expect(id).toEqual({ agentId: "482913", address: "482913@d" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-fleet-key")).toBe("fk");
  });

  it("throws with status and body on non-2xx", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "revoked" }), { status: 403 }));
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await expect(client.me()).rejects.toThrow(/403.*revoked/s);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/client/src/client.test.ts`
Expected: FAIL — cannot resolve `./client.js`.

- [ ] **Step 3: Implement**

`packages/client/src/client.ts`:
```ts
import {
  canonicalString, sign, type AgentIdentity, type EmailFull,
  type EmailSummary, type Keypair,
} from "@agent-identity/shared";

export interface ClientOptions {
  apiUrl: string;
  keypair: Keypair;
  fleetKey?: string;
  fetch?: typeof globalThis.fetch;
}

export class AgentIdentityClient {
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  private async request<T>(method: string, pathWithQuery: string, body = "", extra: Record<string, string> = {}): Promise<T> {
    const timestamp = new Date().toISOString();
    const signature = sign(
      canonicalString(method, pathWithQuery, timestamp, body),
      this.opts.keypair.privateKeyPem,
    );
    const res = await this.fetchFn(`${this.opts.apiUrl}${pathWithQuery}`, {
      method,
      body: body || undefined,
      headers: {
        "x-agent-key": this.opts.keypair.publicKeySpkiBase64,
        "x-agent-timestamp": timestamp,
        "x-agent-signature": signature,
        ...(body ? { "content-type": "application/json" } : {}),
        ...extra,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  register(): Promise<AgentIdentity> {
    return this.request("POST", "/register", "",
      this.opts.fleetKey ? { "x-fleet-key": this.opts.fleetKey } : {});
  }

  me(): Promise<AgentIdentity> {
    return this.request("GET", "/me");
  }

  listEmails(opts: { since?: string; limit?: number; cursor?: string } = {}):
    Promise<{ emails: EmailSummary[]; cursor?: string }> {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", opts.since);
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return this.request("GET", `/emails${qs ? `?${qs}` : ""}`);
  }

  getEmail(id: string): Promise<EmailFull> {
    return this.request("GET", `/emails/${id}`);
  }
}
```

`packages/client/src/index.ts`:
```ts
export * from "./client.js";
export * from "./profile.js";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/client`
Expected: PASS (5 tests: 2 profile + 3 client).

- [ ] **Step 5: Commit**

```bash
git add packages/client && git commit -m "feat(client): signed HTTP client with register/me/listEmails/getEmail"
```

---

### Task 9: mcp — MCP stdio server

**Files:**
- Create: `packages/mcp/src/tools.ts`, `packages/mcp/src/server.ts`
- Test: `packages/mcp/src/tools.test.ts`
- Modify: `packages/mcp/package.json`

Tool logic lives in `tools.ts` (pure, testable, client injected); `server.ts` is thin MCP wiring.

- [ ] **Step 1: Add deps**

`packages/mcp/package.json`:
```json
"dependencies": {
  "@agent-identity/client": "workspace:*",
  "@agent-identity/shared": "workspace:*",
  "@modelcontextprotocol/sdk": "^1.0.0",
  "zod": "^3.23.0"
},
"bin": { "agent-identity-mcp": "./src/server.ts" }
```
Run: `pnpm install`

- [ ] **Step 2: Write failing test**

`packages/mcp/src/tools.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { makeTools } from "./tools.js";

function makeClient(over: Record<string, unknown> = {}) {
  return {
    register: vi.fn(async () => ({ agentId: "482913", address: "482913@d" })),
    listEmails: vi.fn(async () => ({ emails: [] })),
    getEmail: vi.fn(async () => ({ id: "01A", from: "a", subject: "s", receivedAt: "t", text: "b", links: [] })),
    ...over,
  } as never;
}

describe("mcp tools", () => {
  it("ensure_identity registers and persists identity to profile", async () => {
    const save = vi.fn();
    const tools = makeTools(makeClient(), save);
    const res = await tools.ensureIdentity();
    expect(res).toEqual({ agentId: "482913", address: "482913@d" });
    expect(save).toHaveBeenCalledWith({ agentId: "482913", address: "482913@d" });
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
    const tools = makeTools(client, vi.fn());
    const res = await tools.waitForEmail(
      { fromContains: "github", timeoutSeconds: 1 }, { pollMs: 10 },
    );
    expect(res).toEqual(expect.objectContaining({ id: "2" }));
  });

  it("wait_for_email times out cleanly (result, not throw)", async () => {
    const tools = makeTools(makeClient(), vi.fn());
    const res = await tools.waitForEmail({ subjectContains: "never", timeoutSeconds: 0.05 }, { pollMs: 10 });
    expect(res).toEqual({ timedOut: true });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/mcp`
Expected: FAIL — cannot resolve `./tools.js`.

- [ ] **Step 4: Implement tools**

`packages/mcp/src/tools.ts`:
```ts
import type { AgentIdentityClient } from "@agent-identity/client";
import type { AgentIdentity, EmailSummary } from "@agent-identity/shared";

export interface WaitArgs {
  fromContains?: string;
  subjectContains?: string;
  timeoutSeconds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeTools(
  client: AgentIdentityClient,
  persistIdentity: (id: AgentIdentity) => void,
) {
  return {
    async ensureIdentity(): Promise<AgentIdentity> {
      const identity = await client.register();
      persistIdentity(identity);
      return identity;
    },

    listEmails(opts: { since?: string; limit?: number }) {
      return client.listEmails(opts);
    },

    getEmail(id: string) {
      return client.getEmail(id);
    },

    async waitForEmail(
      args: WaitArgs, opts: { pollMs?: number } = {},
    ): Promise<EmailSummary | { timedOut: true }> {
      const pollMs = opts.pollMs ?? 5000;
      const deadline = Date.now() + args.timeoutSeconds * 1000;
      const since = new Date(Date.now() - 60_000).toISOString();
      const matches = (e: EmailSummary) =>
        (!args.fromContains || e.from.toLowerCase().includes(args.fromContains.toLowerCase())) &&
        (!args.subjectContains || e.subject.toLowerCase().includes(args.subjectContains.toLowerCase()));
      for (;;) {
        const { emails } = await client.listEmails({ since, limit: 50 });
        const hit = emails.find(matches);
        if (hit) return hit;
        if (Date.now() >= deadline) return { timedOut: true };
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      }
    },
  };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/mcp`
Expected: PASS (3 tests).

- [ ] **Step 6: Implement server wiring (no unit test; verified in Task 12)**

`packages/mcp/src/server.ts`:
```ts
#!/usr/bin/env -S npx tsx
import { AgentIdentityClient, loadOrCreateProfile, saveProfile } from "@agent-identity/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeTools } from "./tools.js";

const profileName = process.env.AGENT_IDENTITY_PROFILE ?? "default";
const profile = loadOrCreateProfile(profileName);
const client = new AgentIdentityClient({
  apiUrl: process.env.AGENT_IDENTITY_API_URL!,
  keypair: profile,
  fleetKey: process.env.AGENT_IDENTITY_FLEET_KEY,
});
const tools = makeTools(client, (id) =>
  saveProfile({ ...profile, ...id }, profileName));

const server = new McpServer({ name: "agent-identity", version: "0.1.0" });
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

server.tool(
  "ensure_identity",
  "Load or create this agent's identity and mailbox address. Idempotent; call at session start.",
  {},
  async () => json(await tools.ensureIdentity()),
);

server.tool(
  "list_emails",
  "List received emails, newest first.",
  { since: z.string().optional(), limit: z.number().int().max(50).optional() },
  async (args) => json(await tools.listEmails(args)),
);

server.tool(
  "get_email",
  "Get a full email by id, including body text and extracted links.",
  { id: z.string() },
  async ({ id }) => json(await tools.getEmail(id)),
);

server.tool(
  "wait_for_email",
  "Poll until an email matching the filters arrives, or timeout (returns {timedOut:true}).",
  {
    fromContains: z.string().optional(),
    subjectContains: z.string().optional(),
    timeoutSeconds: z.number().max(300).default(120),
  },
  async (args) => json(await tools.waitForEmail(args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Note: check the installed `@modelcontextprotocol/sdk` version's API — if
`server.tool(name, description, schema, handler)` has changed to
`registerTool`, follow the SDK's current signature; the tool names,
descriptions, and zod schemas above are the contract.

- [ ] **Step 7: Smoke-check server loads**

Run: `AGENT_IDENTITY_API_URL=http://localhost:9 timeout 3 npx tsx packages/mcp/src/server.ts < /dev/null; echo "exit ok"`
Expected: no import/syntax errors (process idles waiting on stdio until timeout).

- [ ] **Step 8: Commit**

```bash
git add packages/mcp && git commit -m "feat(mcp): stdio server with ensure_identity/list/get/wait_for_email"
```

---

### Task 10: admin — mailctl CLI

**Files:**
- Create: `packages/admin/src/commands.ts`, `packages/admin/src/mailctl.ts`
- Test: `packages/admin/src/commands.test.ts`
- Modify: `packages/admin/package.json`

- [ ] **Step 1: Add deps**

`packages/admin/package.json`:
```json
"dependencies": {
  "@aws-sdk/client-dynamodb": "^3.600.0",
  "@aws-sdk/lib-dynamodb": "^3.600.0",
  "commander": "^12.1.0"
},
"devDependencies": { "aws-sdk-client-mock": "^4.0.0" },
"bin": { "mailctl": "./src/mailctl.ts" }
```
Run: `pnpm install`

- [ ] **Step 2: Write failing test**

`packages/admin/src/commands.test.ts`:
```ts
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createFleetKey, listAgents, revokeAgent } from "./commands.js";

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

describe("mailctl commands", () => {
  it("createFleetKey stores only the sha256 hash and returns the secret once", async () => {
    ddb.on(PutCommand).resolves({});
    const key = await createFleetKey(ddb as never, "tbl", "ci");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe(`FLEET#${createHash("sha256").update(key).digest("hex")}`);
    expect(JSON.stringify(item)).not.toContain(key);
    expect(item.label).toBe("ci");
  });

  it("listAgents scans AGENT records", async () => {
    ddb.on(ScanCommand).resolves({
      Items: [{ PK: "AGENT#fp1", agentId: "482913", address: "482913@d", status: "active" }],
    });
    const agents = await listAgents(ddb as never, "tbl");
    expect(agents).toEqual([
      { fingerprint: "fp1", agentId: "482913", address: "482913@d", status: "active" },
    ]);
  });

  it("revokeAgent resolves agentId to fingerprint and sets revoked", async () => {
    ddb.on(ScanCommand).resolves({
      Items: [{ PK: "AGENT#fp1", agentId: "482913", address: "a", status: "active" }],
    });
    ddb.on(UpdateCommand).resolves({});
    await revokeAgent(ddb as never, "tbl", "482913");
    const upd = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.Key).toEqual({ PK: "AGENT#fp1", SK: "AGENT" });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/admin`
Expected: FAIL — cannot resolve `./commands.js`.

- [ ] **Step 4: Implement**

`packages/admin/src/commands.ts`:
```ts
import {
  DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomBytes } from "node:crypto";

export async function createFleetKey(
  ddb: DynamoDBDocumentClient, table: string, label: string,
): Promise<string> {
  const key = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");
  await ddb.send(new PutCommand({
    TableName: table,
    Item: { PK: `FLEET#${hash}`, SK: "FLEET", label, createdAt: new Date().toISOString() },
  }));
  return key;
}

export interface AgentRow {
  fingerprint: string;
  agentId: string;
  address: string;
  status: string;
}

export async function listAgents(
  ddb: DynamoDBDocumentClient, table: string,
): Promise<AgentRow[]> {
  const res = await ddb.send(new ScanCommand({
    TableName: table,
    FilterExpression: "SK = :sk",
    ExpressionAttributeValues: { ":sk": "AGENT" },
  }));
  return (res.Items ?? []).map((i) => ({
    fingerprint: (i.PK as string).slice("AGENT#".length),
    agentId: i.agentId as string,
    address: i.address as string,
    status: i.status as string,
  }));
}

export async function revokeAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
): Promise<void> {
  const agent = (await listAgents(ddb, table)).find((a) => a.agentId === agentId);
  if (!agent) throw new Error(`no agent with id ${agentId}`);
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `AGENT#${agent.fingerprint}`, SK: "AGENT" },
    UpdateExpression: "SET #s = :r",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":r": "revoked" },
  }));
}
```

(Scan is fine here: the agents table grows only as the operator mints
identities — spec's growth section.)

`packages/admin/src/mailctl.ts`:
```ts
#!/usr/bin/env -S npx tsx
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Command } from "commander";
import { createFleetKey, listAgents, revokeAgent } from "./commands.js";

const table = process.env.AGENT_IDENTITY_TABLE;
if (!table) {
  console.error("Set AGENT_IDENTITY_TABLE (DynamoDB table name)");
  process.exit(1);
}
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const program = new Command("mailctl");

program.command("fleet-key")
  .command("create")
  .option("--label <label>", "label for this key", "default")
  .action(async (opts: { label: string }) => {
    const key = await createFleetKey(ddb, table, opts.label);
    console.log("Fleet key (shown once, store it now):");
    console.log(key);
  });

const agent = program.command("agent");
agent.command("list").action(async () => {
  console.table(await listAgents(ddb, table));
});
agent.command("revoke <agentId>").action(async (agentId: string) => {
  await revokeAgent(ddb, table, agentId);
  console.log(`revoked ${agentId}`);
});

await program.parseAsync();
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/admin`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/admin && git commit -m "feat(admin): mailctl fleet-key/agent commands"
```

---

### Task 11: infra — CDK stack

**Files:**
- Create: `infra/package.json`, `infra/tsconfig.json`, `infra/cdk.json`, `infra/bin/app.ts`, `infra/lib/stack.ts`
- Test: `infra` synth check (CDK assertions are overkill for v1; `cdk synth` is the test)

- [ ] **Step 1: Package files**

`infra/package.json`:
```json
{
  "name": "@agent-identity/infra",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "aws-cdk-lib": "^2.150.0",
    "constructs": "^10.3.0"
  },
  "devDependencies": { "aws-cdk": "^2.150.0" }
}
```

`infra/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["bin", "lib"] }
```

`infra/cdk.json`:
```json
{ "app": "npx tsx bin/app.ts" }
```

Run: `pnpm install`

- [ ] **Step 2: Stack**

`infra/bin/app.ts`:
```ts
import { App } from "aws-cdk-lib";
import { AgentIdentityStack } from "../lib/stack.js";

const app = new App();
const domain = app.node.tryGetContext("domain") ?? process.env.MAIL_DOMAIN;
if (!domain) throw new Error("Pass -c domain=mail.example.com or set MAIL_DOMAIN");

new AgentIdentityStack(app, "AgentIdentity", {
  domain,
  // SES inbound is only available in us-east-1, us-west-2, eu-west-1
  env: { region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
```

`infra/lib/stack.ts`:
```ts
import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
} from "aws-cdk-lib";
import { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { ReceiptRuleSet } from "aws-cdk-lib/aws-ses";
import * as actions from "aws-cdk-lib/aws-ses-actions";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export interface AgentIdentityStackProps extends StackProps {
  domain: string;
  retentionDays?: number;
}

export class AgentIdentityStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentIdentityStackProps) {
    super(scope, id, props);
    const retentionDays = props.retentionDays ?? 90;

    const table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const bucket = new Bucket(this, "Mail", {
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { prefix: "raw/", expiration: Duration.days(retentionDays) },
        { prefix: "bodies/", expiration: Duration.days(retentionDays) },
        { prefix: "unmatched/", expiration: Duration.days(7) },
      ],
    });

    const commonEnv = {
      TABLE_NAME: table.tableName,
      BUCKET_NAME: bucket.bucketName,
      MAIL_DOMAIN: props.domain,
      RETENTION_DAYS: String(retentionDays),
    };
    const fnDefaults = {
      runtime: Runtime.NODEJS_20_X,
      bundling: { format: OutputFormat.ESM },
      environment: commonEnv,
    };

    const ingestFn = new NodejsFunction(this, "Ingest", {
      ...fnDefaults,
      entry: pkg("ingest/src/handler.ts"),
      timeout: Duration.seconds(30),
    });
    table.grantReadWriteData(ingestFn);
    bucket.grantReadWrite(ingestFn);

    const apiFn = new NodejsFunction(this, "Api", {
      ...fnDefaults,
      entry: pkg("api/src/lambda.ts"),
    });
    table.grantReadWriteData(apiFn);
    bucket.grantRead(apiFn);

    const httpApi = new HttpApi(this, "HttpApi", {
      defaultIntegration: new HttpLambdaIntegration("ApiInt", apiFn),
    });

    new ReceiptRuleSet(this, "Rules", {
      rules: [{
        recipients: [props.domain],
        scanEnabled: true,
        actions: [
          new actions.S3({ bucket, objectKeyPrefix: "raw/" }),
          new actions.Lambda({ function: ingestFn }),
        ],
      }],
    });

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "MxRecord", {
      value: `${props.domain} MX 10 inbound-smtp.${this.region}.amazonaws.com`,
    });
  }
}
```

**Gotchas for the implementer (document these in README, Task 12):**
- SES S3 action writes to `raw/<messageId>` — matches ingest's `rawS3Key`.
- A receipt rule set must be **activated** manually (`aws ses set-active-receipt-rule-set --rule-set-name <name>`); CDK does not activate it.
- The domain must be **verified in SES** (CDK doesn't do this): `aws sesv2 create-email-identity --email-identity <domain>`, then add the DKIM/verification DNS records plus the MX record from the stack output.

- [ ] **Step 3: Verify synth**

Run: `cd infra && npx cdk synth -c domain=mail.example.com > /dev/null && echo SYNTH-OK`
Expected: `SYNTH-OK` (no AWS credentials needed for synth).

- [ ] **Step 4: Commit**

```bash
git add infra && git commit -m "feat(infra): CDK stack — table, bucket lifecycle, SES rules, lambdas, http api"
```

---

### Task 12: e2e script + README

**Files:**
- Create: `scripts/e2e.ts`, `README.md`

- [ ] **Step 1: e2e script (runs only against a deployed dev stack — manual, not in vitest)**

`scripts/e2e.ts`:
```ts
#!/usr/bin/env -S npx tsx
// End-to-end check against a deployed stack.
// Prereqs: deployed stack, active receipt rule set, verified domain,
// env: AGENT_IDENTITY_API_URL, AGENT_IDENTITY_FLEET_KEY, E2E_SMTP_SENDER
// (an address you can send from, e.g. via `aws sesv2 send-email` from the
// same account once the domain is verified, or any external mailbox).
import { AgentIdentityClient, loadOrCreateProfile } from "@agent-identity/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = loadOrCreateProfile("e2e", mkdtempSync(join(tmpdir(), "aid-e2e-")));
const client = new AgentIdentityClient({
  apiUrl: process.env.AGENT_IDENTITY_API_URL!,
  keypair: profile,
  fleetKey: process.env.AGENT_IDENTITY_FLEET_KEY,
});

const id1 = await client.register();
const id2 = await client.register();
if (id1.address !== id2.address) throw new Error("register not idempotent!");
console.log(`identity: ${id1.agentId} <${id1.address}>`);
console.log(`\nSend a test email to ${id1.address} now (subject: e2e-ping).`);
console.log("Polling for it (up to 5 minutes)...");

const deadline = Date.now() + 300_000;
for (;;) {
  const { emails } = await client.listEmails({ limit: 10 });
  const hit = emails.find((e) => e.subject.includes("e2e-ping"));
  if (hit) {
    const full = await client.getEmail(hit.id);
    console.log("RECEIVED:", JSON.stringify(full, null, 2));
    break;
  }
  if (Date.now() > deadline) throw new Error("timed out waiting for e2e-ping");
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("E2E OK");
```

- [ ] **Step 2: README**

`README.md` — write these sections (full prose, no placeholders):
1. **What this is** — one paragraph from the spec's Purpose section.
2. **Quick start (agent)** — MCP config snippet:
```json
{
  "mcpServers": {
    "agent-identity": {
      "command": "npx",
      "args": ["tsx", "/path/to/agent-identity/packages/mcp/src/server.ts"],
      "env": {
        "AGENT_IDENTITY_API_URL": "https://<api-id>.execute-api.<region>.amazonaws.com",
        "AGENT_IDENTITY_FLEET_KEY": "<from mailctl fleet-key create>",
        "AGENT_IDENTITY_PROFILE": "default"
      }
    }
  }
}
```
3. **Deploy (operator)** — verify domain in SES, `cdk deploy -c domain=...`, add DNS records from outputs, activate receipt rule set (exact commands from Task 11 gotchas), `mailctl fleet-key create`.
4. **GitHub onboarding flow** — the 4-step human-assisted flow from the spec.
5. **Security model** — signature auth, isolation, no-delete, operator-visibility caveat (condensed from spec).

- [ ] **Step 3: Full test suite green**

Run: `pnpm vitest run`
Expected: PASS — all packages (~29 tests).

- [ ] **Step 4: Commit**

```bash
git add scripts README.md && git commit -m "docs: README + e2e script"
```

---

## Not in this plan (deliberate)

- Deploying to AWS (operator action; e2e script exists for when a dev stack is up).
- npm publishing config for client/mcp (packages run via workspace + tsx for now).
- Sending email, read/unread state, server-side link following — out of scope per spec.

## Execution notes

- Task order is dependency order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. Tasks 8–11 are mutually independent after 7.
- If a pinned dependency version conflicts at `pnpm install`, take the nearest compatible version — the majors are the contract.
- Every commit is authored by the repo-local git identity (critical-agent0). Never push.






