# Local dev server and side-by-side PR QA

**Date:** 2026-09-26 · **Status:** approved design

## Goal

A reviewer should be able to try a pull request against real fleet data before merging it. They open two copies of agent-identity side by side (**base** = `main`, **PR** = the branch), each with its own API, fleet dashboard and database, and they post a verdict (a comment plus a label) back to the PR.

The harness is [`@critical-labs/qa-conductor`](https://github.com/critical-labs/qa-conductor). It owns sessions, the harness UI, the mirrored pane proxies and verdicts, and it reaches the app only through five adapters. agent-identity is its second consumer, after homefree. This design specifies agent-identity's side: a local dev server (C1) and the QA adapters (C2).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where panes run | Locally, on the reviewer's machine, as processes | agent-identity has no staging or preview environment, and there is no Docker locally. Remote hosting is a later stage. |
| Database per pane | **DynamoDB Local**, the official emulator (Java), started with `-inMemory` | dynalite lacks `TransactWriteItems`, which registration and mailbox creation use. |
| Pane shape | One process per pane: a **dev server** that serves the API at its normal paths and the fleet dashboard at `/ui/` | A single origin means no CORS problem and no path prefix, so signed requests are unchanged. The server lives in the app, so it versions with the code. |
| Data | Real prod table, scanned read-only once per session, **mail redacted**, held in memory only | QA against realistic data, while mailboxes can hold live credentials. |
| Where adapters live | This repo, `packages/qa` | Consumers own their adapters. |

## C1: local dev server (`pnpm dev`)

C1 is useful without QA: it's the first way to run the API and dashboard locally.

- **`packages/api/src/deps.ts`:** `buildDeps({ env, ddb, readBody })` turns env vars into `Deps`. The rules are the ones `lambda.ts` has today: `TABLE_NAME` and `MAIL_DOMAIN` are required, `RETENTION_DAYS` defaults to 90, `FLEET_KEY_REQUIRED` is on unless set to exactly `false`, and `PUBLIC_REPOS` / `AUTO_CAPABILITIES` fail closed when empty. `lambda.ts` becomes a thin caller. The Lambda and dev entries therefore can't drift, and a PR that changes `Deps` changes both.
- **`packages/api/src/dev-app.ts`:**
  - `createDevApp(deps, { uiFile })` is an outer Hono app. It answers `GET /ui` (redirect to `/ui/`) and `GET /ui/` (the dashboard HTML, read on every request) **before** mounting `createApp(deps)` at `/`. That order matters: `createApp` puts signature auth on every other path. It also adds the CORS headers API Gateway adds in production (`*`, `GET`, `content-type, x-viewer-key`), so a dashboard served from elsewhere also works.
  - `ensureTable(client, tableName)` creates the table if it's missing. The key schema comes from the shared `TABLE_KEYS` constant, and a stack test asserts it matches the CDK table.
- **`packages/api/src/dev.ts`** is the entry point, run with `tsx`.
  - It **refuses to start** unless `AWS_ENDPOINT_URL_DYNAMODB` or `AWS_ENDPOINT_URL` points somewhere, so a dev server can never talk to a real table by accident.
  - It then builds deps from env. `readBody` returns a "stored in S3, not available locally" stub, because only oversized mail bodies live in S3.
  - It runs `ensureTable` and serves on `127.0.0.1:${PORT ?? 8787}` via `@hono/node-server`.
- **`packages/shared/src/table.ts`:** `TABLE_KEYS = { partitionKey: "PK", sortKey: "SK", ttlAttribute: "expiresAt" }`.
- **Root script:** `"dev": "tsx packages/api/src/dev.ts"`.
- **README "Local development" section:** start DynamoDB Local, run `pnpm dev`, and mint a viewer key with `mailctl viewer-key create` (same endpoint env). Then open `http://127.0.0.1:8787/ui/?api=http://127.0.0.1:8787#key=<key>`.

## C2: QA adapters (`packages/qa`, private)

`pnpm qa` starts the conductor locally: the harness on `127.0.0.1:3100` and the panes on `3101` / `3102`. `pnpm qa:setup` downloads DynamoDB Local once, pinned to a version and checked against its SHA-256.

| Seam | Implementation |
|---|---|
| **Provisioner** | `provisionDatabase`: spawns DynamoDB Local (`-inMemory`) on a free loopback port, waits for `ListTables`, and returns `{ dsn: endpoint, db: { endpoint, tableName } }`. `reserveServices`: a free port per pane. `launchServices`: spawns `pnpm exec tsx packages/api/src/dev.ts` in the pane's checkout, with the pane env only. `waitHealthy`: `GET /ui/` returns 200. `teardown`: kills both process groups (TERM, then KILL). `logs`: a per-pane ring buffer of child output. `sweep`: kills processes left in the pidfile by a previous run. |
| **BuildConvention** | Migrations are `on-boot`: the dev server and the seed both call `ensureTable`. `ensureBuilt(pr)` checks the PR author is an owner, member or collaborator, fetches `pull/N/head`, and creates a detached worktree per commit under the cache directory. It then runs `pnpm install --frozen-lockfile --ignore-scripts` (packages run from source, so there's no build). Base is `origin/main`. `describePrs` reports built, building or none from the worktree cache. Only the most recent 6 worktrees are kept. |
| **Seed** | Once per session, it looks up the table name from the `AgentIdentity` stack and does a read-only Scan with the operator's default AWS credentials. The snapshot is **kept in memory, never written to disk**. `seedPane` runs `ensureTable` and then batch-writes the redacted snapshot. |
| **EnvTransform** | Each pane gets an explicit env and inherits **nothing** from the harness process. That env is: the pane's DynamoDB endpoint, dummy AWS credentials and region, `TABLE_NAME=agent-identity-qa`, `PORT`, `MAIL_DOMAIN` / `PUBLIC_REPOS` / `AUTO_CAPABILITIES` from the QA config, and `FLEET_KEY_REQUIRED=true`. |
| **AuthBootstrap** | `requiresDb`. It mints a fresh 32-byte viewer key per pane and writes `VIEWER#sha256(key)` to that pane's table. `landingUrl` is `<paneOrigin>/ui/?api=<paneOrigin>#key=<key>`. The key is in the fragment, so it never reaches a server or proxy log. |

**Redaction** is a pure function with tests:
- **Emails:** `messageId`, `from`, `receivedAt`, `auth` and `unsolicited` are kept. `subject` is kept with digit runs of 4 or more and URLs masked. `text` becomes `[redacted for QA]`, and `html`, `links` and `bodyS3Key` are removed.
- **Dropped:** `FLEET#`, `ADMINKEY#` and `VIEWER#` key hashes, and `NONCE#` items.
- **Copied unchanged:** everything else (agents, address mirrors, activity, status).

**Security** (this runs PR code on the reviewer's machine):
- Only trusted authors' PRs can be booted.
- Installs skip lifecycle scripts.
- Panes get a scrubbed env and bind to loopback.
- Real AWS credentials are used only inside the harness process, for the read-only Scan.

## Interface notes for qa-conductor

- **PaneDb is adapter-private.** The core only passes `db` from `provisionDatabase` to `seedPane` / `establishSession`. Here it's `{ endpoint, tableName }`, not homefree's SQL `query`, and qa-conductor's docs should say so.
- **`QA_OPERATOR_EMAIL` is required by `loadConfig`** but meaningless for key-based auth. It should become optional.
- **Build progress** (`subscribeBuild`) is shaped around a CI run URL; a local install only has messages.

These are fixed in qa-conductor only if they block C2; otherwise they're recorded for 0.2.0.

## Dependencies and sequencing

1. **C1** merges first, because the base pane runs `main`.
2. **C2** depends on `@critical-labs/qa-conductor` from git. This repo is public and CI runs `pnpm install`, so **qa-conductor must be public before C2 merges**.

## Testing

- **C1:** unit tests (vitest) cover:
  - `buildDeps` env parsing, mirroring today's `lambda.ts` behaviour;
  - `createDevApp` serving `/ui/` without auth while `/fleet/*` stays viewer-key-gated and other paths stay signature-gated;
  - the CORS headers;
  - `ensureTable` (create when missing, no-op when present) with `aws-sdk-client-mock`;
  - `TABLE_KEYS` against the synthesized stack.
- **C1 manual check:** DynamoDB Local + `pnpm dev` + a minted viewer key → the dashboard loads and lists agents.
- **C2:** unit tests for the redaction (including "no body text, links or key hashes survive"), the env transform (no inherited AWS variables), key minting, the provisioner with an injected spawn, and the build's trusted-author check.
- **C2 end-to-end:** boot a real PR, open both dashboards through the harness, confirm no mail content is visible, post a verdict, tear down, and confirm no processes remain.
