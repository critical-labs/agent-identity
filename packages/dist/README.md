# @critical-labs/agent-identity

Know **which agents do what work**. agent-identity gives every AI agent a persistent, verifiable identity — so commits, pull requests, API calls, and email verifications all trace back to a managed identity. Attribution is the stepping stone to real management of agents and their productivity in fully-autonomous settings.

![agent-identity setup demo](https://raw.githubusercontent.com/critical-labs/agent-identity/main/docs/assets/demo-setup.gif)

**This is self-hosted software.** Before this package can do anything you deploy your own AWS SES backend — an AI agent can walk you through it — or obtain an API URL and fleet key from an operator already running one. See the [deploy guide](https://github.com/critical-labs/agent-identity/blob/main/infra/README.md).

## Features

- **Persistent identities** — an Ed25519 keypair per agent, generated client-side; a permanent numeric ID assigned at registration. No bearer tokens: every API call is signed.
- **A real email mailbox per identity** (`<id>@<your-domain>`, receive-only, AWS SES) — agents complete verification loops and receive service notifications themselves. Inbound mail carries SES SPF/DKIM/DMARC verdicts; hard failures are quarantined before an agent ever reads them.
- **Verifiable code authorship** via the forge proxy: agents fork, commit, and open PRs/MRs through a credential-holding proxy that **force-authors every commit as the acting identity** and never lets an agent write to a source repo (fork-and-PR, enforced server-side).
- **GitLab: full self-onboarding** — an identity provisions its own service account end to end, confirming the signup email in its own mailbox. No human in the loop.
- **GitHub: shared-bot attribution** — signup stays human (ToS), so agents work through one bot account while each commit still carries its identity as author.
- **Session identity pool** — the MCP server claims one identity per session from a machine-local pool; concurrent sessions get distinct identities, reused across sessions rather than re-created.
- **Batteries included** — MCP server, CLI setup wizard with per-step verification, a Claude Code skill, and a TypeScript client library.

## Install & set up (consuming repo)

```bash
npm install @critical-labs/agent-identity
npx -y -p @critical-labs/agent-identity agent-identity setup
```

The setup wizard prompts for your backend URL and fleet key, writes `~/.config/agent-identity/fleet_key` (mode 0600), provisions identities into the local pool, writes `.mcp.json`, and installs the bundled skill into your repo.

## What you get

- **`agent-identity-mcp`** — MCP server with tools: `ensure_identity`, `identity_status`, `list_emails`, `get_email`, `wait_for_email`, plus the forge tools (`forge_repo`, `forge_fork`, `forge_sync`, `forge_commit`, `forge_deliver`, `forge_open_pr`, `forge_comment`, `forge_provision`) on capable identities. Prefer `npx -y @critical-labs/agent-identity-mcp` in MCP configs — the single-bin wrapper can never resolve to a lookalike package.
- **`agent-identity`** — CLI with commands: `setup`, `pool provision`, `pool status`, `github link`, `github onboard`
- **Library** — import directly from the package:

```ts
import { AgentIdentityClient, claimFromPool } from "@critical-labs/agent-identity";
```

## Secrets

Secrets never live in `.mcp.json`. The fleet key is stored at `~/.config/agent-identity/fleet_key` (mode 0600) and read at runtime when `AGENT_IDENTITY_FLEET_KEY` is unset. Forge credentials live server-side (SSM) — agents never hold them.

## Source, deploy & operator docs

https://github.com/critical-labs/agent-identity
