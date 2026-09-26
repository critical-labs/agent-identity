# Local dev server (C1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm dev` runs the API and the fleet dashboard on one local port against DynamoDB Local.

**Architecture:**
- `lambda.ts` and a new dev entry share one `buildDeps(env)`.
- The dev entry wraps `createApp` in an outer Hono app. That app serves the dashboard at `/ui/`, and adds API Gateway's CORS headers on GET, before the API is mounted at its normal paths.
- `ensureTable` creates the table from a shared key-schema constant, which a stack test ties to the CDK table.

**Tech stack:** TypeScript run with `tsx`, Hono 4 plus `@hono/node-server`, AWS SDK v3, and vitest with `aws-sdk-client-mock`.

**Spec:** `docs/internal/specs/2026-09-26-local-dev-and-qa-harness-design.md` (C1).

**Conventions:**
- Use `pnpm vitest run <file>` for single files, and `pnpm vitest run` plus `npx tsc --noEmit -p tsconfig.base.json` for the full check.
- Add dependencies with **`npx pnpm@9`**: CI pins pnpm 9, and the lockfile must stay `lockfileVersion: '9.0'`.

---

### Task 1: Shared table key schema

**Files:**
- Create `packages/shared/src/table.ts`.
- Modify `packages/shared/src/index.ts` and `infra/lib/stack.test.ts`.

- [ ] **Step 1: Failing test.** Append to `infra/lib/stack.test.ts`:

```ts
import { TABLE_KEYS } from "../../packages/shared/src/table.js";

describe("table key schema", () => {
  it("matches the shared TABLE_KEYS the local dev server creates tables from", () => {
    synth().hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: TABLE_KEYS.partitionKey, KeyType: "HASH" },
        { AttributeName: TABLE_KEYS.sortKey, KeyType: "RANGE" },
      ],
      TimeToLiveSpecification: { AttributeName: TABLE_KEYS.ttlAttribute, Enabled: true },
    });
  });
});
```

- [ ] **Step 2:** Run `pnpm vitest run infra/lib/stack.test.ts`. Expected: FAIL, because `table.js` can't be resolved.
- [ ] **Step 3:** Create `packages/shared/src/table.ts`:

```ts
/** The single DynamoDB table's key schema. infra/lib/stack.ts defines the
 *  deployed table; the local dev server and the QA harness create tables
 *  from this constant, and a stack test keeps the two in step. */
export const TABLE_KEYS = {
  partitionKey: "PK",
  sortKey: "SK",
  ttlAttribute: "expiresAt",
} as const;
```

Then add `export * from "./table.js";` to `packages/shared/src/index.ts`.

- [ ] **Step 4:** Run the same test. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(shared): shared table key schema, tied to the CDK table by test`.

### Task 2: `buildDeps`, one env → `Deps` path for Lambda and dev

**Files:**
- Create `packages/api/src/deps.ts` and `packages/api/src/deps.test.ts`.
- Modify `packages/api/src/lambda.ts`.

- [ ] **Step 1: Failing tests** in `deps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildDeps } from "./deps.js";

const ddb = {} as never;
const readBody = async () => ({ text: "", links: [] });
const base = { TABLE_NAME: "t", MAIL_DOMAIN: "mail.example.com" };

describe("buildDeps", () => {
  it("applies lambda.ts's defaults", () => {
    const d = buildDeps({ env: base, ddb, readBody });
    expect(d.fleetKeyRequired).toBe(true);
    expect(d.publicRepos).toEqual([]);
    expect(d.autoCapabilities).toEqual([]);
    expect(d.mailDomain).toBe("mail.example.com");
    expect(d.readBody).toBe(readBody);
  });

  it("FLEET_KEY_REQUIRED is off only for exactly 'false'", () => {
    expect(buildDeps({ env: { ...base, FLEET_KEY_REQUIRED: "false" }, ddb, readBody }).fleetKeyRequired).toBe(false);
    expect(buildDeps({ env: { ...base, FLEET_KEY_REQUIRED: "no" }, ddb, readBody }).fleetKeyRequired).toBe(true);
  });

  it("parses PUBLIC_REPOS and AUTO_CAPABILITIES", () => {
    const d = buildDeps({ env: { ...base, PUBLIC_REPOS: "Acme/Widget", AUTO_CAPABILITIES: " github, ,x " }, ddb, readBody });
    expect(d.publicRepos).toEqual(["acme/widget"]);
    expect(d.autoCapabilities).toEqual(["github", "x"]);
  });

  it("requires TABLE_NAME and MAIL_DOMAIN", () => {
    expect(() => buildDeps({ env: { MAIL_DOMAIN: "d" }, ddb, readBody })).toThrow(/TABLE_NAME/);
    expect(() => buildDeps({ env: { TABLE_NAME: "t" }, ddb, readBody })).toThrow(/MAIL_DOMAIN/);
  });
});
```

(Before asserting `acme/widget`, check what `parseRepoAllowlist` actually normalizes to and match it.)

- [ ] **Step 2:** Run it. Expected: FAIL, because `deps.js` doesn't exist.
- [ ] **Step 3:** Create `deps.ts`, moving `lambda.ts`'s construction and comments into it verbatim, and make `lambda.ts` call it:

```ts
import { parseRepoAllowlist } from "@agent-identity/shared";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Deps } from "./app.js";
import { ActivityRepo } from "./db/activity.js";
import { AgentsRepo } from "./db/agents.js";
import { EmailsRepo } from "./db/emails.js";
import { NoncesRepo } from "./db/nonces.js";

type Env = Record<string, string | undefined>;

const required = (env: Env, key: string): string => {
  const v = env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
};

/** The one env → Deps mapping, shared by the Lambda entry and the local dev
 *  server so the two cannot drift. */
export function buildDeps({ env, ddb, readBody }: {
  env: Env;
  ddb: DynamoDBDocumentClient;
  readBody: Deps["readBody"];
}): Deps {
  const table = required(env, "TABLE_NAME");
  const domain = required(env, "MAIL_DOMAIN");
  const retentionDays = Number(env.RETENTION_DAYS ?? "90");
  return { /* the lambda.ts object, with its comments, reading env */ };
}
```

After the move, `lambda.ts` keeps only the clients, the S3 `readBody`, `buildDeps({ env: process.env, ddb, readBody })` and `handle(app)`. Note that `BUCKET_NAME` stays in `lambda.ts`, because only Lambda reads S3.

- [ ] **Step 4:** Run `deps.test.ts` and the full api suite. Expected: PASS.
- [ ] **Step 5:** Commit: `refactor(api): one env-to-Deps builder shared by Lambda and dev`.

### Task 3: `createDevApp` and `ensureTable`

**Files:**
- Create `packages/api/src/dev-app.ts` and `dev-app.test.ts`.
- Modify `packages/api/package.json` (runtime dependency `@hono/node-server`, and `@aws-sdk/client-dynamodb` for `CreateTableCommand`, which is already there).

- [ ] **Step 1: Failing tests:**
  - `GET /ui/` → 200 with the HTML from `uiFile`, no credentials needed.
  - `GET /ui` → 301 to `/ui/`.
  - `GET /fleet/agents` without a key → 401 (still viewer-gated).
  - `GET /v1/whatever` → 401 (still signature-gated).
  - GET responses carry `access-control-allow-origin: *`.
  - `ensureTable` sends `CreateTableCommand` with the `TABLE_KEYS` schema and `PAY_PER_REQUEST` when `DescribeTableCommand` rejects with `ResourceNotFoundException`, and sends nothing when the table exists.

  These use the `makeDeps` style from `app.test.ts`, and `mockClient(DynamoDBClient)`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement:

```ts
import { readFile } from "node:fs/promises";
import { TABLE_KEYS } from "@agent-identity/shared";
import { CreateTableCommand, DescribeTableCommand, ResourceNotFoundException, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createApp, type Deps } from "./app.js";

/** Local composition: the dashboard at /ui/ (registered BEFORE the API,
 *  whose signature auth covers every other path), API Gateway's CORS on
 *  GET, then the API at its normal paths. */
export function createDevApp(deps: Deps, { uiFile }: { uiFile: string }): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET"], allowHeaders: ["content-type", "x-viewer-key"], maxAge: 3600 }));
  app.get("/ui", (c) => c.redirect("/ui/", 301));
  app.get("/ui/", async (c) => c.html(await readFile(uiFile, "utf8")));
  app.route("/", createApp(deps));
  return app;
}

export async function ensureTable(client: DynamoDBClient, tableName: string): Promise<"created" | "exists"> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return "exists";
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  await client.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: TABLE_KEYS.partitionKey, AttributeType: "S" },
      { AttributeName: TABLE_KEYS.sortKey, AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: TABLE_KEYS.partitionKey, KeyType: "HASH" },
      { AttributeName: TABLE_KEYS.sortKey, KeyType: "RANGE" },
    ],
  }));
  return "created";
}
```

Check that `cors()` doesn't change the existing OPTIONS answer; the API's own `app.options("*")` handles preflights. If it does, restrict the middleware to GET.

- [ ] **Step 4:** Add the dependency with `npx pnpm@9 --filter @agent-identity/api add @hono/node-server`. Confirm `head -1 pnpm-lock.yaml` is still `lockfileVersion: '9.0'`, then run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api): dev app composition and ensureTable`.

### Task 4: `pnpm dev` entry, safety guard and docs

**Files:**
- Create `packages/api/src/dev.ts`.
- Modify the root `package.json` and `README.md`.

- [ ] **Step 1: Failing test** (`dev-app.test.ts`): `assertLocalEndpoint(env)` throws unless `AWS_ENDPOINT_URL_DYNAMODB` or `AWS_ENDPOINT_URL` is set, and returns the endpoint otherwise.
- [ ] **Step 2: Implement.** Put `assertLocalEndpoint` in `dev-app.ts`. `dev.ts` then:
  - calls `assertLocalEndpoint(process.env)`;
  - builds `DynamoDBClient({})`, which picks up the endpoint env var itself;
  - builds deps with `buildDeps`, using a `readBody` that returns `{ text: "[stored in S3 — not available in the local dev server]", links: [] }`;
  - runs `ensureTable`;
  - calls `serve({ fetch: createDevApp(deps, { uiFile }).fetch, hostname: "127.0.0.1", port })`, where `port` is `PORT ?? 8787` and `uiFile` is `packages/dist/fleet/index.html` resolved from the file's own location;
  - logs the URL.

  Add the root script `"dev": "tsx packages/api/src/dev.ts"`.
- [ ] **Step 3:** Add a README section "Local development":
  1. Start DynamoDB Local: `java -jar DynamoDBLocal.jar -inMemory -port 8000`.
  2. Set the env: `AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:8000`, `AWS_REGION=us-east-1`, dummy keys, `TABLE_NAME=agent-identity-dev`, `MAIL_DOMAIN=mail.localhost`.
  3. Run `pnpm dev`.
  4. Mint a key: `AGENT_IDENTITY_TABLE=agent-identity-dev npx tsx packages/admin/src/mailctl.ts viewer-key create --label dev`.
  5. Open `http://127.0.0.1:8787/ui/?api=http://127.0.0.1:8787#key=<key>`.
- [ ] **Step 4:** Full check: `pnpm vitest run` and `npx tsc --noEmit -p tsconfig.base.json`.
- [ ] **Step 5:** Commit: `feat(api): pnpm dev — local API + fleet dashboard against DynamoDB Local`.

### Task 5: Manual end-to-end check

- [ ] Fetch DynamoDB Local from AWS's official download into a scratch directory and start it `-inMemory`.
- [ ] Run `pnpm dev` with the README env. `/ui/` should load, and the table should be created.
- [ ] Mint a viewer key with `mailctl` against the same endpoint.
- [ ] Write one agent item directly. The dashboard should connect via the deep link and list the agent (checked in the browser).
- [ ] Without the endpoint env, `pnpm dev` should refuse to start.
- [ ] Stop everything and confirm no processes remain.

### Task 6: PR

- [ ] Push to the `critical-agent-zero/agent-identity` fork and open a PR to `critical-labs/agent-identity` with the spec, this plan and the code. Do not self-merge.
