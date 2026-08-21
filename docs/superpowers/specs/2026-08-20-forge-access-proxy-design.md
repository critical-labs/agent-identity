# Forge access proxy — design

Date: 2026-08-20
Status: approved

## Problem

Giving an agent GitHub access today means giving it a credential: a GitHub
account whose PAT lives wherever the agent runs. That has three compounding
costs. Every new agent needs its own account — and GitHub's anti-abuse
systems block bulk signups of machine-looking accounts (observed directly:
signup for `critical-agent-956112` was rejected on 2026-08-20). Every
machine in a future fleet needs secrets copied to it — the key-distribution
problem the session-identity-claiming design deliberately deferred. And an
agent holding a raw credential can use it in ways no client-side guard-rail
can prevent.

Issues #22 and #23 propose the fix: a central access-control layer that
holds service credentials and proxies agent↔service calls. This spec covers
the #22 MVP — the proxy with credential custody and an allow-all policy
stub — generalized over forges (GitHub, and later GitLab / Codeberg-style
Gitea/Forgejo) via a ports-and-adapters architecture. #23's policy engine
is explicitly out of scope but gets its seam here.

Decisions locked in during brainstorming:

- **Surface: high-level intent operations**, not raw REST pass-through and
  not git-protocol proxying. Typed endpoints for create-commit, open-PR,
  comment, and repo info. Policy sees structured requests; commit
  authorship is enforced by construction.
- **Ports and adapters**: handlers depend on a forge-neutral `Forge` port;
  GitHub is the first adapter. Routes, capabilities, and credentials are
  keyed by service name so new forges are additive.
- **Deployment: new Lambda, same stack.** `packages/proxy` joins the
  existing `AgentIdentity` CDK stack behind the existing HTTP API under
  `/forge/*`. Only this Lambda can read the PAT; the mail API is untouched.
- **Credential storage: SSM SecureString** per service
  (`/agent-identity/forge/github/pat`), IAM-scoped to the proxy Lambda.
- **Authorization: the existing capability tag.** `capabilities` on the
  agent record gates access; the capability name is the service name
  (`github` gates `/forge/github/*`).
- **Consumers: client library + MCP tools** (`forge_commit`,
  `forge_open_pr`, `forge_comment`, `service` defaulting to `github`).

## Architecture

A second Hono Lambda, `packages/proxy`, mounted on the existing HTTP API at
`ANY /forge/{proxy+}`. It reuses the api package's `signatureAuth`
middleware and the agents/nonces DynamoDB repos — same Ed25519
canonical-string auth, same ±5-minute skew, same replay-nonce rejection,
same revocation handling. The mail API Lambda gains nothing and loses
nothing.

Request flow:

```
agent ── signed request ──▶ API GW ──▶ proxy Lambda
  signatureAuth (verify, replay-reject, load agent record)
  capability check: service name ∈ agent.capabilities, else 403
  policy stub: evaluate(agent, service, op) → allow   (allow-all in MVP)
  adapter registry: service → Forge adapter, else 404
  adapter call with credential from CredentialStore
  audit log line → CloudWatch
  normalized response / error
```

The hexagon: route handlers and the operation core know nothing about any
specific forge. Two ports face outward —

```ts
interface Forge {
  getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo>;   // default branch, head sha
  createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult>;
  openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult>;
  comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult>;
}

interface CredentialStore {
  resolve(service: string, agentId: string): Promise<string>;  // per-identity first, shared fallback
}
```

Domain types are forge-neutral: `RepoRef { owner, name }`, `CommitSpec
{ branch, message, files: [{ path, content }] }`, `PrSpec { head, base,
title, body }`. Every operation executes *as* an identity: `Author
{ name, email }` is constructed by the core from the authenticated agent
record (`agentId`, mailbox address) and passed to every adapter call as
the actor; no request field and no adapter accepts caller-supplied
authorship. GitHub uses the actor for commit authorship over the shared
PAT; GitLab additionally uses `actor.name` (the agentId) to resolve that
identity's own service-account PAT, so the acting user and the author are
the agent natively. Adapters translate intent into their forge's API and map
failures into a normalized error taxonomy owned by the core: `NotFound`,
`NonFastForward`, `RateLimited`, `UpstreamAuthFailed`, `Invalid`.

Two real adapters ship: `github` (shared PAT) and `gitlab` (per-identity
service accounts — see the GitLab section), plus an in-memory `FakeForge`
used by tests. Delivery is sequenced as two PRs: proxy + GitHub adapter
first, GitLab adapter + provisioning second. Gitea/Forgejo remains a
future adapter; its single-call contents API fits the same intent-level
port.

## HTTP surface

All routes require a valid signature and the service capability.

- `POST /forge/{service}/commit` — body `{ owner, repo, branch, message,
  files: [{ path, content }] }`. GitHub adapter: resolve branch ref → create
  blobs → tree (based on branch head) → commit with the forced author →
  fast-forward ref update. Force-push does not exist in this surface; a
  non-fast-forward outcome is `409 non_fast_forward`. Returns
  `{ sha, url }`.
- `POST /forge/{service}/pr` — body `{ owner, repo, head, base, title,
  body }`. Returns `{ number, url }`. The proxy appends a one-line
  attribution footer to the body ("opened by agent NNNNNN via
  agent-identity proxy") because the forge shows the credential account as
  the PR author.
- `POST /forge/{service}/comment` — body `{ owner, repo, issue, body }`.
  Same attribution footer. Returns `{ id, url }`.
- `GET /forge/{service}/repo/{owner}/{repo}` — returns `{ defaultBranch,
  headSha }`, the minimum a client needs to drive the commit flow.

Error mapping: unknown service → `404 unknown_service`; missing capability
→ `403 missing_capability` with remediation text naming `mailctl agent
tag`; taxonomy errors map to `404 / 409 / 429 / 502 / 400` respectively.
`UpstreamAuthFailed` is reported as `502 upstream_credential_invalid` with
no upstream detail leaked.

## Credentials

Resolution is per-identity first, shared fallback:
`/agent-identity/forge/<service>/pat/<agentId>` then
`/agent-identity/forge/<service>/pat`, both SSM SecureString, cached in
memory for 5 minutes. The CDK stack grants read+decrypt to the proxy
Lambda only.

**GitHub** uses the shared path: one fine-grained PAT minted by the
operator on the backing account (`critical-agent-zero`), restricted to
the repos agents may touch — the outer blast-radius boundary while policy
is allow-all. Set out-of-band (`aws ssm put-parameter --type SecureString
...`, echoed in the deploy job summary).

**GitLab** is per-identity only — there is no shared GitLab PAT, and an
unprovisioned identity gets a clear `not_provisioned` error naming the
provision step.

## GitLab service accounts (per-identity)

GitLab's API sanctions bot accounts: a top-level group Owner token can
create *service accounts* (`POST /groups/:id/service_accounts`) with a
custom email and mint PATs for them
(`POST /groups/:id/service_accounts/:user_id/personal_access_tokens`).
This closes the onboarding loop GitHub blocks: the service account's
email is **the agent's own mailbox address**, so the confirmation email
arrives via the agent's existing mail tools and the agent confirms
itself. Free tier allows 100 service accounts per top-level group.

`POST /forge/gitlab/provision` (signature-authed, `gitlab`-capability-
gated, idempotent) provisions the calling identity: find-or-create the
service account (`username: agent-<agentId>`, `name: agent <agentId>`,
`email: <address>`), add it to the group as Developer, mint a PAT
(`scopes: ["api"]`, 365-day expiry), and store it at the identity's SSM
path. Returns `{ username, email }`. Operator config in SSM:
`/agent-identity/forge/gitlab/admin-token` (group Owner token — the
proxy's most sensitive credential) and `/agent-identity/forge/gitlab/group`
(top-level group id). The proxy Lambda gets `ssm:PutParameter` on the
`/agent-identity/forge/gitlab/pat/*` prefix only. PAT rotation before the
365-day expiry is out of scope (re-provisioning mints a fresh one).

The `GitlabForge` adapter implements the same port: repo info via
`GET /projects/:path` + branch head; commit via the single-call commits
API (`actions[]` with per-file create/update chosen by a file-existence
probe, `author_name`/`author_email` forced from the actor); MR via
`POST /projects/:path/merge_requests` (`PrResult.number` is the MR iid);
comment maps to **issue** notes (GitLab separates issue and MR
discussions; MR notes are out of scope — a documented asymmetry with
GitHub, where one endpoint covers both). A matching `forge_provision` MCP
tool lets a session self-onboard: provision → `wait_for_email` → confirm
via the extracted link.

## Audit

Every operation emits one structured JSON line to CloudWatch Logs:
`{ agentId, service, op, owner, repo, outcome, upstreamStatus, latencyMs }`.
Queryable per identity with Logs Insights. A durable DynamoDB audit trail
belongs to #23 and is not built here.

## Policy seam

`policy.evaluate(agent, service, op)` is called on every request and
returns allow in MVP. `op` is the parsed, typed operation — exactly what
#23's deterministic rules need. The forced author and the absence of
force-push are properties of the surface, not policy rules; they hold even
with allow-all.

## Client and MCP surface

`@agent-identity/client` gains typed methods on the existing signed client:
`forgeRepo(service, ref)`, `forgeCommit(service, ref, spec)`,
`forgeOpenPr(service, ref, spec)`, `forgeComment(service, ref, issue,
body)`.

`@agent-identity/mcp` gains tools `forge_commit`, `forge_open_pr`,
`forge_comment` (and `forge_repo`), each with a `service` parameter
defaulting to `"github"`, acting as the session's claimed identity. When
the identity lacks the capability, the tool returns the proxy's remediation
error as a clean result so the agent can relay onboarding steps to the
human. The bundled skill gains a section describing the tools and the
attribution model.

## Infrastructure

CDK additions to the existing stack: a `NodejsFunction` for
`packages/proxy/src/lambda.ts`, an HTTP API route `ANY /forge/{proxy+}`,
IAM grants for the DynamoDB table (read agents, write nonces) and the SSM
parameter (read+decrypt). The deploy job summary gains the PAT setup
command. No new stack outputs beyond the unchanged `ApiUrl`.

## Testing

House TDD throughout. Proxy handlers are tested with the `FakeForge`
adapter and an in-memory `CredentialStore`; auth and capability tests
mirror the api package's existing patterns (the middleware itself is
already covered there). The GitHub adapter is tested against an injected
`fetch` fake asserting exact upstream calls (blob/tree/commit sequence,
forced author, fast-forward update). Client methods and MCP tools are
tested with fakes as elsewhere in the repo. CI is unchanged: vitest, tsc,
cdk synth. A real-PAT end-to-end run is a manual script, not CI.

## Out of scope

Git-protocol push/fetch, PR merge/review/close operations, file deletion
or renames in commits (`files` entries create or update only), explicit
binding records, #23 policy rules beyond the seam, Gitea/Forgejo
adapters, GitLab MR-note comments, GitLab PAT rotation before expiry,
DynamoDB audit trail, rate limiting, non-forge services.
