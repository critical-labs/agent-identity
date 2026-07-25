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
