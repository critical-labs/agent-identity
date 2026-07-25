# @critical-labs/agent-identity

Persistent, verifiable identities for AI agents. Each identity gets an Ed25519 keypair and a receive-only email mailbox (`<id>@<your-domain>`). An MCP server claims one session-scoped identity from a machine-local pool on startup and exposes it through five tools. A setup CLI walks a consuming repo through backend wiring, pool provisioning, and `.mcp.json` configuration in one interactive session.

## Install & set up (consuming repo)

```bash
npm install @critical-labs/agent-identity
npx agent-identity setup
```

The setup wizard prompts for your backend URL and fleet key, writes `~/.config/agent-identity/fleet_key` (mode 0600), provisions identities into the local pool, writes `.mcp.json`, and installs the bundled skill into your repo.

## What you get

- **`agent-identity-mcp`** — MCP server with tools: `ensure_identity`, `identity_status`, `list_emails`, `get_email`, `wait_for_email`
- **`agent-identity`** — CLI with commands: `setup`, `pool provision`, `pool status`, `github link`
- **Library** — import directly from the package:

```ts
import { AgentIdentityClient, claimFromPool } from "@critical-labs/agent-identity";
```

## Secrets

Secrets never live in `.mcp.json`. The fleet key is stored at `~/.config/agent-identity/fleet_key` (mode 0600) and read at runtime when `AGENT_IDENTITY_FLEET_KEY` is unset.

## Source, deploy & operator docs

https://github.com/critical-labs/agent-identity
