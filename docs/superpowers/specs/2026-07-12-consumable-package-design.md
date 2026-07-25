# Consumable package & setup wizard — design

Date: 2026-07-12
Status: approved

## Problem

agent-identity can only be consumed from a source checkout: the MCP config
points at `npx tsx /path/to/agent-identity/packages/mcp/src/server.ts`, the
workspace packages export raw TypeScript, and nothing guides a consuming
repo through configuration. The user's project **homefree** must be able to
adopt agent-identity with one `npm install` plus one guided setup command.
Separately, the first six identities must be onboarded: critical-agent-zero
(existing GitHub account `critical-agent0`) plus five plain identities that
receive GitHub accounts later as needed.

Decisions locked in during brainstorming:

- Backend choice in setup: **both** paths, existing-first. Connect-to-
  existing is fully built; deploy-new is a guided checklist (the CLI prints
  each step's exact command, verifies completion, and advances) — not full
  automation.
- Distribution: **public npm registry**. The bare name `agent-identity` is
  taken, so the package is **`@critical-labs/agent-identity`** (npm org to
  be created; matches the GitHub org).
- Shape: **one consumer package**. Operator packages (api, ingest, admin,
  infra) stay unpublished in the monorepo.
- Setup UX: **CLI wizard + thin skill**. The wizard works without Claude;
  the bundled skill teaches the agent to use the tools and guide the human.
- critical-agent-zero onboarding: the GitHub account's primary email is
  **switched to its new agent address** (verification email through the
  agent mailbox is the end-to-end test).
- The five extra identities are minted **via the new `pool provision`
  CLI** against production — dogfooding what consumers get.

## Architecture

A new aggregate publish package, `packages/dist/`, is the only published
artifact. It contains no logic of its own: tsup bundles entry points from
the existing workspace packages (`client`, `mcp`, `shared` compiled in via
`noExternal`), while third-party dependencies (`commander`, `zod`,
`@modelcontextprotocol/sdk`) remain ordinary npm dependencies. The dev
monorepo is untouched: workspace packages stay private, unbuilt, tsx-run.

Published contents:

- `dist/index.js` + `index.d.ts` — re-exports the client public API
  (claims, pool, profiles, `AgentIdentityClient`).
- `dist/cli.js` → bin **`agent-identity`** — setup wizard, pool
  provision/status, github link.
- `dist/server.js` → bin **`agent-identity-mcp`** — the MCP server.
- `skill/` — the Claude Code skill as plain files, copied by setup.

Bins carry real `#!/usr/bin/env node` shebangs; consumers never need tsx.

New CLI code lives in the source packages it belongs to (wizard and
provision in `packages/client/src/`), so the monorepo dev flow and tests
cover it; `packages/dist` only re-exports and bundles.

## Secret handling change (MCP server + client)

`.mcp.json` is typically committed, so the fleet key must not live there.
`fleetKey` resolution order everywhere (MCP server and CLI): the
`AGENT_IDENTITY_FLEET_KEY` env var, else the file
`~/.config/agent-identity/fleet_key` (mode 600) — which is where the
operator's key already lives. Setup writes only the API URL into
`.mcp.json`; the key goes to the file.

Machine-level defaults live in `~/.config/agent-identity/config.json`
(`{ "apiUrl": string }`), written by setup and read by CLI commands as the
default for `--api-url`.

## CLI surface

`agent-identity` (commander; prompts via `node:readline/promises` — no new
prompt dependency):

**`setup`** — interactive wizard, run from the consuming repo root:

1. Backend: *connect to existing* or *deploy new*.
   - Existing: prompt for API URL and fleet key (accept a literal value or
     skip if `~/.config/agent-identity/fleet_key` exists). Validate the URL
     with an unauthenticated `GET /me` — an HTTP 401 response proves the
     API is reachable and is the expected service. Persist: key →
     `fleet_key` file (600), URL → `config.json`.
   - New: guided checklist mirroring the README deploy steps. The CDK
     stack and mailctl are not published, so the first step is cloning
     the agent-identity repo; subsequent commands run from that checkout.
     For each step the wizard prints the exact command, waits, then
     verifies before advancing: AWS credentials
     (`sts get-caller-identity`), CDK bootstrap + stack deployed
     (CloudFormation describe-stacks outputs), MX record resolves (DNS
     lookup), receipt rule set active
     (`ses describe-active-receipt-rule-set`), fleet key minted (file
     exists). A failed check prints what failed and re-prompts; it never
     aborts the wizard. Ends in the same persisted state as the existing
     path.
2. "How many identities should I provision now?" (default 0) — runs the
   same code as `pool provision`.
3. "Should this repo require a GitHub-capable identity?" — if yes, sets
   `AGENT_IDENTITY_REQUIRE=github` in the server env block.
4. Merges the `agent-identity` server entry into the repo's `.mcp.json`:
   parse-modify-write that touches only the `mcpServers["agent-identity"]`
   key and preserves everything else; unparseable JSON aborts with a clear
   error rather than clobbering. Entry: command `agent-identity-mcp`, env
   `AGENT_IDENTITY_API_URL` (+ optional `AGENT_IDENTITY_REQUIRE`). No key.
5. Copies the bundled skill into `.claude/skills/agent-identity/`
   (overwrite prompt if present).

**`pool provision --count N [--api-url --fleet-key]`** — mints N
identities: generate keypair → register → `savePoolProfile`. Defaults from
`config.json` / fleet-key file. Prints each new agentId and address.

**`pool status`** — human-readable wrapper around the existing
`poolStatus()`.

**`github link`** — exists already; unchanged.

## The skill (thin)

`skill/SKILL.md`, copied into the consumer's `.claude/skills/`. Content:
call `ensure_identity` at session start and `{"require":["github"]}`
before GitHub work; the human-assisted GitHub onboarding checklist (who
does what at each step: human creates the account, agent fetches the
verification email, operator tags, local link); and pointers to
`npx agent-identity setup` / `pool provision` when the human needs
guidance. No logic in the skill — the CLI is the source of truth.

## Publish pipeline

`.github/workflows/publish.yml`: on `v*` tag push → run tests → build
`packages/dist` → smoke-test both built bins with `--help` → `npm publish
--provenance --access public` using the `NPM_TOKEN` secret. Version lives
in `packages/dist/package.json`; tagging is the publish act.

One-time human steps: create the `critical-labs` npm org; add an
automation token as the `NPM_TOKEN` repo secret.

## Identity onboarding runbook (operational; after the package lands)

1. `agent-identity pool provision --count 6` against production — six
   plain identities in the pool.
2. critical-agent-zero: the human switches the GitHub account's primary
   email to identity #1's address. An agent session watches via
   `wait_for_email` for GitHub's verification email and surfaces the link
   — end-to-end proof of the loop. Then `mailctl agent tag <id> github`
   and `agent-identity github link <id> --username critical-agent0
   --credential-ref op://...`.
3. The other five remain plain until GitHub accounts are created for them,
   each following the same tag + link steps.

## Error handling

- Wizard steps are pure functions (answers in → actions out) behind a thin
  prompt loop, so every branch is unit-testable without a TTY.
- `.mcp.json` merge refuses to proceed on unparseable JSON; it never
  rewrites entries it does not own.
- Connect-path URL validation treats only "reachable + 401" as success;
  network errors and unexpected statuses re-prompt with the observed
  failure.
- The fleet key is validated implicitly by the first provision call; a 403
  reports "fleet key rejected" with the file path being used.
- Deploy-path checklist verification failures print the failed check and
  re-prompt; the wizard never destroys or modifies AWS state itself.
- `pool provision` reports per-identity failures and continues (N attempts,
  M succeeded); partial success is normal, not an error.

## Testing

- Unit: wizard decision logic per branch; `.mcp.json` merge (fresh file,
  existing servers preserved, corrupt JSON aborts); `config.json` +
  fleet-key file read/write and env-var precedence; provision with a fake
  client (count, partial failure); skill copy.
- Existing suites unchanged; the MCP fleet-key fallback gets a test in
  `claim-manager` / server config parsing.
- Build smoke test in CI: execute both built bins with `--help` before
  publish.
- Provisioning against production and the CA0 email switch remain manual
  e2e, per the runbook.

## Out of scope

- Full automation of AWS deploy in the wizard (checklist only, v1).
- Publishing operator packages (mailctl et al.).
- Automated GitHub account creation (human-assisted by design).
- Any change to the claiming/locking design shipped in the previous
  feature.
