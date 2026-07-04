# agent-identity — Design

**Date:** 2026-07-04
**Status:** Approved for planning

## Purpose

Give AI agents a persistent, verifiable identity whose first capability is a
receive-only email mailbox, backed by AWS SES. The driving use case: an agent
needs an email address to obtain a GitHub account so it can author commits,
open and review PRs, and receive notifications.

The project is open-source and self-hostable. The reference deployment (the
author's) is private: only the operator's own agents may register, gated by a
fleet key.

## Core concepts

- **Identity = Ed25519 keypair.** Generated client-side on first use, stored at
  `~/.config/agent-identity/<profile>.json` (mode `0600`). Profile defaults to
  `default`; `AGENT_IDENTITY_PROFILE` or MCP config selects others, so one
  machine can host several named agents. The reuse boundary is the machine
  user, not the workspace.
- **Address = identity handle.** Registration assigns a random numeric ID
  (e.g. `482913`); the mailbox address is `<id>@<domain>`. Numbers only, no
  names. Identity and mailbox are born together.
- **Fleet key.** A shared secret minted by the admin CLI. It authorizes
  *joining* the instance (`POST /register`); the keypair authorizes everything
  after. Self-hosters may disable the fleet-key requirement for open
  registration.

## Isolation and immutability rules

- One address per identity, assigned once, permanent.
- Registration is idempotent: the same public key always resolves to the same
  identity and address, on N attempts.
- The API carries no agent or address parameters; every request is scoped to
  the caller resolved from its signature. Cross-agent reads are impossible by
  construction.
- **No delete operations exist** — not for agents, not for the operator's API.
  Emails leave only via 90-day TTL.
- Numeric IDs are **never reused**, even after revocation. Revoked agents
  remain as tombstones: a revoked agent's address may back a live external
  account (e.g. GitHub), and reassigning it would hand over that account's
  recovery path.
- Admin CLI can revoke an identity (its signatures are refused) but cannot
  read or delete its mail through the API.
- Threat-model honesty: isolation is an API-layer boundary between *agents*.
  Anyone with AWS-account access can read S3/DynamoDB directly. This is not
  encryption against the operator.

## Request authentication

Every API call is signed with the agent's Ed25519 private key over
method + path + timestamp + body hash (HTTP Message Signatures style). The
server resolves signature → public key → agent. Timestamp skew tolerance:
±5 minutes. No bearer tokens.

## Architecture (serverless, AWS)

### Inbound mail path

1. SES receipt rule for `<domain>` → raw MIME to S3 (`raw/` prefix) →
   triggers **ingest Lambda**.
2. Ingest Lambda:
   - Drops messages failing SES spam/virus verdicts.
   - Looks up recipient local-part in the agents table. Unknown → drop
     (optional `unmatched/` S3 prefix with 7-day lifecycle, for debugging).
   - Parses MIME (`mailparser`), writes an email record to DynamoDB:
     metadata (from, subject, receivedAt, agentId), parsed text/HTML body,
     **pre-extracted links**, `expiresAt` TTL = 90 days (configurable per
     deployment).
   - Raw MIME retained in S3 under `raw/<agentId>/`, expired by lifecycle
     rule on the same 90-day clock.
3. Bodies exceeding DynamoDB's 400KB item limit overflow to a parsed-body S3
   object referenced from the item; the API reads through transparently.

### API path

API Gateway (HTTP API) → single **api Lambda** with an internal router
(Hono). Endpoints:

- `POST /register` — public key + fleet key → `{agentId, address}`.
  Idempotent.
- `GET /me` — caller's identity and address.
- `GET /emails?since=&limit=&cursor=` — caller's mailbox, newest-first
  summaries.
- `GET /emails/{id}` — full email (text body, links; HTML on request).
  Server verifies the record belongs to the caller.

No admin HTTP endpoints. Fleet keys, revocation, and agent listing are done
by the admin CLI directly against DynamoDB using operator AWS credentials.

### Data model

Single DynamoDB table:

- `AGENT#<pubkeyFingerprint>` → agentId, publicKey, address, status
  (active/revoked), createdAt. Plus a GSI or mirror item keyed by numeric ID
  for ingest lookups.
- `MAILBOX#<agentId>` / `EMAIL#<receivedAt>#<ulid>` → email records. One
  query lists a mailbox newest-first with native pagination.

### Growth management

- Email records: DynamoDB TTL (free deletes) + S3 lifecycle, both at 90 days.
  Steady-state = 90 days × inbound volume.
- Spam: SES verdicts + unknown-recipient drop mean address-spray never
  touches DynamoDB.
- Agent records: permanent by design, few hundred bytes each; grows only as
  the operator mints identities.

### Infra

CDK app (TypeScript). Config: domain name + region (SES inbound is limited
to us-east-1, us-west-2, eu-west-1). `cdk deploy` outputs the API URL and the
DNS records (MX + domain verification) to create. Idle cost ≈ $0 (no VPC/NAT,
pay-per-request DynamoDB).

## Client package — `@agent-identity/client`

Plain TypeScript, zero AWS dependencies; speaks HTTPS to the API only.
Responsibilities: keypair generation/loading per profile, request signing,
typed methods `register()`, `me()`, `listEmails()`, `getEmail()`.
Env config: `AGENT_IDENTITY_API_URL`, `AGENT_IDENTITY_FLEET_KEY`,
`AGENT_IDENTITY_PROFILE`.

## MCP server — `@agent-identity/mcp`

Stdio server, run via `npx @agent-identity/mcp`; thin wrapper over the
client. Tools:

- `ensure_identity` — load-or-create keypair, register, return
  `{agentId, address}`. Call at session start. Idempotent.
- `list_emails` — `{since?, limit?}` → summaries (id, from, subject,
  receivedAt).
- `get_email` — `{id}` → full text body + extracted links.
- `wait_for_email` — `{fromContains?, subjectContains?, timeoutSeconds}` —
  client-side polling until a match arrives; timeout returns a clean
  "timeout" result, not an error.

Link-following is the **agent's** job with its own tools; this service moves
email and nothing else (no server-side `follow_link` — avoids SSRF surface).

## Admin CLI — `mailctl` (packages/admin)

Operator tool using AWS credentials directly: mint/rotate fleet keys, list
agents, revoke identities.

## GitHub onboarding flow (v1 use case)

GitHub blocks automated signups (ToS requires human account creation;
CAPTCHA enforces it). The flow is therefore **human-assisted at exactly one
step**:

1. Agent calls `ensure_identity` → gets `482913@<domain>`.
2. Agent asks its human to complete the GitHub signup form using that
   address (human handles ToS acceptance and CAPTCHA).
3. GitHub sends a verification email; agent retrieves it with
   `wait_for_email` / `get_email` and surfaces the verification link (agent
   or human follows it).
4. Account is live: the agent's human configures credentials/PAT as they see
   fit; ongoing notification email flows to the agent's mailbox, readable via
   MCP.

Future: per-service onboarding playbooks, including bot-friendly hosts
(e.g. Codeberg/Gitea instances). Out of scope for v1.

## Out of scope (v1)

- Sending email (SES production access, DKIM/SPF, bounce handling) — receive
  only. API shapes need not reserve send endpoints.
- Server-side link following.
- Admin HTTP API, billing, public multi-tenancy.
- Read/unread state on emails.
- Additional identity capabilities beyond mail.

## Error handling

- Invalid/missing signature → 401. Revoked identity → 403.
- Registration without valid fleet key (when required) → 403.
- Client retries 5xx with exponential backoff.
- `wait_for_email` timeout is a result, not an exception.

## Testing

TDD throughout.

- Unit: signing/verification, MIME parsing, numeric-ID assignment,
  idempotent registration.
- API: in-process Hono handler tests with mocked DynamoDB.
- E2E: scripted test against a real dev deployment — send a real email
  through SES, observe arrival via the MCP tools.

## Repo layout

pnpm workspace, single repo (`agent-identity`):

```
packages/
  shared/     # types, signing (client + api)
  client/     # @agent-identity/client
  mcp/        # @agent-identity/mcp
  api/        # api Lambda (Hono router)
  ingest/     # SES ingest Lambda
  admin/      # mailctl CLI
infra/        # CDK app
docs/
```
