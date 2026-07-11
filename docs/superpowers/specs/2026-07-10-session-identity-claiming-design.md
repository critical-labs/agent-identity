# Session identity claiming — design

Date: 2026-07-10
Status: approved

## Problem

Nothing ensures a Claude Code session has an agent identity, and nothing
prevents two concurrent sessions from using the same one. Identities with
manually-created GitHub accounts are scarce (human signup + CAPTCHA), so
sessions must be able to (a) require a GitHub-capable identity or accept any,
and (b) prefer re-using an existing identity that is not in use by another
session over creating a new one.

## Scope

Machine-local pool now (identities are local keypair files; sessions run on
one host). The claim/release interface is a clean seam so a server-backed
lease pool can replace it when fleet support is needed. Server-side work in
this design is limited to capability tagging on the agent record.

Decisions locked in during brainstorming:

- Release model: claim lifetime = MCP server process lifetime, with
  PID-liveness detection for crashed holders. No TTL leases.
- Capability record: **both** server-side tag (source of truth, fleet-ready
  inventory) and local profile metadata (operational credentials).
- Requirement declaration: per-project config (env var on the MCP server)
  with a runtime override on `ensure_identity`.
- Exhaustion: plain identity → auto-create; GitHub-capable → fail loudly
  (cannot be auto-created; account signup is human-assisted by design).
- Mailbox continuity across claims is accepted as-is: identities are shared
  tools; whoever legitimately holds the key reads the full mailbox,
  including (for GitHub identities) security/password-reset email. No
  visibility boundary.

## Architecture

The MCP server process is the claim holder: it claims a profile at startup,
holds it for its lifetime, and its death — clean or not — is the release.
This ties claim lifetime to the only process that can use the identity and
eliminates all cross-process coordination (no SessionEnd hook, no
hook↔server handoff).

Touchpoints:

- `packages/client` — new `claims.ts`: pure library for pool scan, claim,
  release, stale detection. Interface: `claim(requirements) → Profile`,
  `release()`.
- `packages/mcp` — claims on startup, releases on exit, exposes swap and
  status tools.
- `packages/api` — agent record gains `capabilities?: string[]`; `GET /me`
  returns it.
- `packages/admin` — `mailctl agent tag|untag <agentId> <capability>`;
  `agent list` shows capabilities.
- Hooks — optional SessionStart context injection, documented; not required
  for correctness.

## Local data layout

Under `~/.config/agent-identity/`:

```
pool/<name>.json     # claimable profiles: keypair, agentId, address,
                     #   optional github: { username, credentialRef? }
claims/<name>.lock   # { pid, claimedAt, host } — existence = claimed
default.json         # loose profiles outside pool/ are never claimed
e2e.json
```

- Pool profiles live in `pool/` specifically so ad-hoc profiles used by
  scripts are never claimed out from under them.
- New pool profiles are named by agentId after registration.
- `github.credentialRef` is a reference (e.g. an `op://` pointer), never a
  plaintext credential.

## Claim lifecycle

**Claim (MCP server startup):**

1. Read requirement from `AGENT_IDENTITY_REQUIRE` (comma-separated
   capability list, e.g. `github`; empty = any).
2. List `pool/*.json`; filter to profiles satisfying every required
   capability (local `github` block = has the capability).
3. For each candidate (lexicographic by profile name), atomically create
   `claims/<name>.lock` with the `wx` open flag. On `EEXIST`, liveness-check
   the recorded PID; if dead, remove the stale lock and retry. Bounded
   retries with jitter cover takeover races.

**Exhaustion:**

- No free plain identity → generate keypair, register (requires
  `AGENT_IDENTITY_FLEET_KEY`), save to `pool/`, claim it.
- No free GitHub-capable identity → the claim fails with an actionable
  error. The MCP server still starts; identity-dependent tools return the
  error with remediation (onboard a new GitHub identity or free one up).

**Release:** `exit`/`SIGINT`/`SIGTERM` handlers unlink the server's own
lock. SIGKILL or crash leaves the lock behind; the next claimer's liveness
check reclaims it. Session end kills the stdio server, so session end
releases the claim with no hook involvement.

**Mid-session swap:** `ensure_identity({require})` on a server whose held
identity does not qualify claims a qualifying profile *first*, then releases
the old one. If the swap fails, the current claim is kept and the error is
reported — a session is never left identity-less by a failed upgrade.

## Capability tagging & GitHub onboarding

Two records with distinct jobs:

- **Server-side (source of truth):** `capabilities: string[]` on the agent
  record, set only by the operator via mailctl. Registration never sets it.
  `GET /me` returns it so any key-holder can see what its identity is
  registered as.
- **Local (operational):** the pool profile's `github` block holds what the
  machine needs to use the account (`username`, optional `credentialRef`).
  Claim filtering reads only local state — no network call in the claim
  path.

Onboarding checklist (documented in README):

1. Session claims/mints a plain identity → `482913@<domain>`.
2. Human creates the GitHub account with that address (form + CAPTCHA);
   agent fetches the verification email via `wait_for_email`.
3. `mailctl agent tag 482913 github`
4. `agent-identity github link 482913 --username <gh-login>
   [--credential-ref op://...]` writes the local block. This is a new,
   small CLI entry point (`bin`) added to `packages/client`; the package
   currently ships no executable.

Steps 3 and 4 are deliberately separate: mailctl is the operator/AWS tool;
the local link is machine state.

## MCP surface, hooks, config

- `AGENT_IDENTITY_REQUIRE` is set where the MCP server is declared
  (per-project `.mcp.json` / settings env). No new config file format.
- `ensure_identity` gains optional `require: string[]`: no-op if the held
  identity qualifies; swap otherwise.
- New read-only tool `identity_status`: held identity, its capabilities,
  pool availability counts (free/claimed, by capability). Explains claim
  failures and shows what is free.
- Optional SessionStart hook injects one line of context ("call
  `ensure_identity` before workflows needing email"). It does not claim.

## Error handling

- Two live claimers can never hold the same lock (atomic `wx` create).
  Takeover races resolve via bounded retry with jitter.
- Claim failure at startup never crashes the MCP server; errors surface
  through tools, structured, with remediation text.
- Auto-create without a fleet key → error naming `AGENT_IDENTITY_FLEET_KEY`.
- Corrupt profile or lock JSON → skip the entry, warn, continue the scan.
- Known limitation (accepted for v1): PID reuse after reboot can make a
  stale lock look live, leaving one identity unavailable until the lock in
  `claims/` is removed by hand. The directory is user-inspectable plain
  JSON.

## Testing

- `claims.ts` unit tests (tmp dirs, injected liveness check): claim/release
  round-trip, capability filtering, two-claimer contention, stale takeover,
  exhaustion → create (plain) / fail (github), corrupt-file resilience.
- MCP integration: startup claim; `ensure_identity` idempotence and swap
  paths; spawned-subprocess kill → lock released or reclaimable.
- API/admin: `/me` returns capabilities; repo tag/untag; mailctl commands.
- `scripts/e2e.ts` untouched (uses a loose profile outside the pool).

## Out of scope

- Server-side lease pool, `/claim`/`/release` endpoints, key distribution
  between machines (fleet phase).
- Enforced per-claim mailbox visibility boundaries.
- Automated GitHub account creation (ToS/CAPTCHA — human-assisted by
  design).
