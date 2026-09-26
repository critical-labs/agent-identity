# agent-identity

## What this is

agent-identity exists to make agent work **attributable**: every action an agent takes — a commit, a pull request, a signed API call, an email verification — traces back to a persistent identity you manage. Knowing which agent did what work is the stepping stone to true management of agents and their productivity in fully-autonomous settings.

The identity itself is an Ed25519 keypair generated client-side on first use and stored at `~/.config/agent-identity/<profile>.json`. Registration assigns a permanent random numeric ID; its first capability is a receive-only email mailbox backed by AWS SES at `<id>@<domain>` — numbers only, no names. Identity and mailbox are born together and are immutable. On top of that, the forge proxy gives identities verifiable authorship on GitLab and GitHub: commits are force-authored as the acting identity, GitLab identities self-onboard their own service accounts end to end, and on GitHub — where ToS keeps signup human — agents work through a shared bot account while each commit still carries its author's identity.

**The product is and always will be self-hosted.** There is no shared service to sign up for. You either deploy your own AWS backend — an AI agent can walk you through it step by step; see **[infra/README.md](infra/README.md)** — or obtain an API URL and fleet key from an operator who already runs one. Every deployment is gated by a fleet key so only that operator's own agents may register.

Two milestones set expectations. A **working identity with a mailbox** is a few hours of AWS and DNS setup: deploy the CDK stack, verify your domain in SES, add the DNS records, mint a fleet key. A **GitHub-capable identity** additionally needs a human — GitHub's signup form and CAPTCHA (or verifying a bot account's email), operator tagging of the identity — and a decision about who holds the resulting Personal Access Token.

The rest of this README splits into the **[Adopter path](#adopter-path)** — install the package, run the setup wizard, use the MCP tools and session claiming — and the **[Operator path](#operator-path)** — deploy and run the AWS backend, administer the fleet, hold forge credentials, CI/CD.

## Adopter path

### Install and set up

```bash
npm install @critical-labs/agent-identity
npx -y -p @critical-labs/agent-identity agent-identity setup
```

The setup wizard connects you to an existing deployment (API URL + fleet
key) or guides a new AWS deployment step-by-step, optionally provisions
pool identities, writes the `agent-identity` entry into `.mcp.json`, and
installs the bundled Claude Code skill into `.claude/skills/`.

The fleet key is stored at `~/.config/agent-identity/fleet_key` (mode 600)
and the API URL at `~/.config/agent-identity/config.json`; `.mcp.json`
contains no secrets. The MCP server reads `AGENT_IDENTITY_FLEET_KEY` from
the environment first and falls back to the key file.

Manual MCP configuration (what the wizard writes):

```json
{
  "mcpServers": {
    "agent-identity": {
      "command": "npx",
      "args": ["-y", "-p", "@critical-labs/agent-identity", "agent-identity-mcp"],
      "env": { "AGENT_IDENTITY_API_URL": "https://<api-id>.execute-api.<region>.amazonaws.com" }
    }
  }
}
```

The repo ships this shape as [`.mcp.json.example`](.mcp.json.example);
`agent-identity setup` generates the real `.mcp.json`, which is gitignored
because it points at your deployment.

Other CLI commands:
`npx -y -p @critical-labs/agent-identity agent-identity pool provision --count N` (mint
identities into the machine-local pool),
`npx -y -p @critical-labs/agent-identity agent-identity pool status`, and
`npx -y -p @critical-labs/agent-identity agent-identity github link <agentId> --username <login>`.

### MCP tools

Call `ensure_identity` at the start of every session — it claims an identity from the local pool (creating one if the pool is empty), registers with the server (idempotent), and returns your `agentId` and `address`. The other tools are `list_emails` (returns summaries with id, from, subject, receivedAt), `get_email` (returns full text body and extracted links for a given id), `wait_for_email` (polls until a matching message arrives; when the timeout elapses it returns `{timedOut: true}` as a clean result, not an error), and `identity_status` (shows what this session holds and what is free in the pool). Following links in retrieved emails is the agent's own job — the server does not fetch URLs.

### Session identity claiming

Each MCP server process claims one identity from a machine-local pool at startup and holds it for its lifetime. Concurrent sessions get distinct identities; identities are reused across sessions rather than re-created.

#### Pool layout

```
~/.config/agent-identity/
  pool/<agentId>.json   claimable profiles (keypair + address + optional github block)
  claims/<agentId>.lock existence = claimed; contains {pid, claimedAt, host}
```

Profiles outside `pool/` (e.g. `default.json`) are never claimed.

#### Requiring a GitHub-capable identity

Set `AGENT_IDENTITY_REQUIRE=github` in the MCP server's env (e.g. in `.mcp.json`). The agent can also call `ensure_identity` with `{"require": ["github"]}` to swap mid-session. If no GitHub-capable identity is free, the claim fails with remediation instructions — it is never auto-created. A plain identity IS auto-created (and added to the pool) when the pool is exhausted, using `AGENT_IDENTITY_FLEET_KEY`.

Use the `identity_status` tool to see what is held and what is free.

#### Onboarding a GitHub-capable identity

1. A session claims/mints a plain identity, e.g. `482913@<domain>`.
2. A human creates the GitHub account with that address (form + CAPTCHA); the agent fetches the verification email via `wait_for_email`.
3. `mailctl agent tag 482913 github`
4. `npx -y -p @critical-labs/agent-identity agent-identity github link 482913 --username <gh-login> [--credential-ref op://...]`

#### Stuck locks

A crashed holder's lock is reclaimed automatically (dead-PID detection). After a reboot, PID reuse can rarely leave a stale lock that looks live: delete the file in `~/.config/agent-identity/claims/` by hand.

#### Optional SessionStart hook

Claiming needs no hook. To surface the identity to the agent at session start, add to `.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
  "command": "echo 'agent-identity MCP is available; call ensure_identity before workflows needing email.'" }] }] } }
```

### GitHub onboarding flow

GitHub blocks automated signups — their Terms of Service require human account creation and a CAPTCHA enforces it. The flow is therefore human-assisted at exactly one step:

1. The agent calls `ensure_identity` and receives its permanent address, for example `482913@mail.example.com`.
2. The agent asks its human to complete the GitHub signup form using that address. The human handles ToS acceptance and the CAPTCHA — this is the one step that cannot be automated.
3. GitHub sends a verification email to the agent's mailbox. The agent calls `wait_for_email` (with `subjectContains` matching GitHub's subject line), then `get_email` to retrieve the full message and surface the verification link. The agent or human follows the link to confirm the account.
4. The account is live. The agent's human configures credentials or a Personal Access Token as they see fit. Ongoing GitHub notification email flows to the agent's mailbox and is readable via `list_emails` / `get_email`.

### Forge access (code, commits, PRs)

Once an identity has a forge account, it acts on code through a credential-holding **proxy** on the same signed API — it forks a source repo, commits to its own fork, and opens PRs/MRs back, never writing to the source (enforced by both credential scope and a deterministic policy). GitLab-capable identities can **self-onboard end to end** (a service account whose email is the agent's own mailbox, so it receives and confirms its own signup with no human step), while GitHub accounts stay human-assisted as above. See **[Forge access — the code-forge proxy](docs/forge-access.md)** for the approach and why GitLab fits agents better than GitHub.

## Operator path

### Deploy

**[infra/README.md](infra/README.md)** is the complete step-by-step deploy guide — prerequisites, CDK bootstrap and deploy, SES/DNS records, receipt-rule activation, fleet-key minting, cost expectations, troubleshooting — written so an AI agent can drive a human through it. The short version:

SES inbound email is only available in **us-east-1**, **us-west-2**, and **eu-west-1**; deploy into one of those regions.

1. `pnpm install`, then `cd infra && npx cdk deploy -c domain=mail.example.com`. The stack outputs the API URL, the MX record value, the receipt rule set name, and the table name.

   The API is rate-limited by default (25 req/s steady, 50 burst, across all routes) so a discovered endpoint can't run up your Lambda/DynamoDB bill. Tune with `-c apiThrottleRate=N -c apiThrottleBurst=N` if your fleet needs more headroom.

2. Verify your domain in SES (`aws sesv2 create-email-identity`, then the DKIM CNAMEs and verification TXT record) and add the MX record from the stack's `MxRecord` output.

3. Activate the SES receipt rule set — CDK creates it but does not activate it:
   ```bash
   aws ses set-active-receipt-rule-set --rule-set-name <ReceiptRuleSetName from stack output>
   ```
   **Warning:** this REPLACES the account's currently active rule set. If the account already receives mail through SES, merge this stack's rule into the existing active set instead of switching sets — see [infra/README.md](infra/README.md#4-activate-the-receipt-rule-set). SES sandbox status does not affect receiving; no production-access request is needed for this stack.

4. Mint a fleet key so agents can register:
   ```bash
   AGENT_IDENTITY_TABLE=<TableName output> npx tsx packages/admin/src/mailctl.ts fleet-key create --label <label>
   ```
   Give the resulting key to agents via the `AGENT_IDENTITY_FLEET_KEY` environment variable.

### Fleet administration

Admin operations — listing agents, tagging capabilities (`mailctl agent tag <id> github|gitlab`), revoking an identity, minting fleet/admin/viewer keys — use the `mailctl` CLI with operator AWS credentials directly against DynamoDB. The one admin HTTP surface is the capability API (`POST`/`DELETE /admin/agents/:id/capabilities`), gated by the admin key (`mailctl admin-key create`) and used by `agent-identity github enable|disable`; keep that key out of agent session environments — it grants capability admin over every identity. Forge credentials (a GitLab group Owner token, a GitHub fork-namespace PAT) are held server-side in SSM, never by agents — see [docs/forge-access.md](docs/forge-access.md) for operator setup.

### CI/CD (GitHub Actions)

`.github/workflows/deploy.yml` tests and deploys the stack on every push to `main`, or on demand from the Actions tab (`workflow_dispatch`). Deploys authenticate to AWS via GitHub OIDC — no long-lived AWS keys are stored in GitHub.

One-time setup (run in CloudShell, or any shell with admin credentials, in your target region — SES inbound requires us-east-1, us-west-2, or eu-west-1):

1. Bootstrap the CDK toolkit:
   ```bash
   npx aws-cdk@2 bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION
   ```

2. Create the OIDC provider and deploy role, using the template from **your own checkout** and naming **the repository the deploy workflow runs in** (add `CreateOidcProvider=false` to the parameter overrides if the account already has a GitHub OIDC provider):
   ```bash
   aws cloudformation deploy --template-file infra/github-oidc.yml \
     --stack-name agent-identity-github-oidc --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubOrg=<your-org> GitHubRepo=<your-repo>
   aws cloudformation describe-stacks --stack-name agent-identity-github-oidc \
     --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
   ```
   The `--parameter-overrides` are not optional for self-hosters: the template's defaults name the upstream repo (`critical-labs/agent-identity`), so deploying without them creates a role that trusts **upstream's** repository — upstream maintainers could then deploy into your AWS account (the role delegates to the account's `cdk-*` roles, which is admin-equivalent). The role's trust `sub` claim must name **your** repository.

3. In repo **Settings → Environments**, create an environment named `production` (optionally require reviewers to gate deploys).

4. In repo **Settings → Secrets and variables → Actions**, set:
   - Under **Secrets**: `MAIL_DOMAIN` — the mail domain, e.g. `mail.example.com` (a secret, not a variable, so the public workflow logs mask it)
   - Under **Variables**: `AWS_REGION` — e.g. `us-east-1`
   - Under **Variables**: `AWS_DEPLOY_ROLE_ARN` — the `DeployRoleArn` output from step 2

5. Run the **deploy** workflow from the Actions tab. The job summary lists the remaining manual steps (DNS MX record, SES domain verification, fleet key); stack outputs are not published on this public repo — read them with `aws cloudformation describe-stacks --stack-name AgentIdentity --query 'Stacks[0].Outputs'`. The workflow activates the SES receipt rule set automatically — the same caveat applies: activation replaces the account's active rule set, so if the account already receives mail via SES, merge rules instead (see [infra/README.md](infra/README.md#4-activate-the-receipt-rule-set)).

If the deploy job fails at `configure-aws-credentials`, the usual cause is a trust-policy mismatch: the role only trusts `repo:<GitHubOrg>/<GitHubRepo>:environment:<EnvironmentName>` as configured in step 2, so the org/repo and environment name must match exactly.

### Local development

`pnpm dev` runs the API and the fleet dashboard on one loopback port (`8787` by default, `PORT` to change it) against a local DynamoDB. It creates the table on first start. It **refuses to start** unless `AWS_ENDPOINT_URL_DYNAMODB` (or `AWS_ENDPOINT_URL`) is set, so it can never reach a real table.

1. Start [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html) (Java 17+): `java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000`
2. In another shell, set the local environment and start the server:
   ```bash
   export AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:8000 AWS_REGION=us-east-1 \
     AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
     TABLE_NAME=agent-identity-dev MAIL_DOMAIN=mail.localhost
   pnpm dev
   ```
3. Mint a viewer key against the same table: `AGENT_IDENTITY_TABLE=agent-identity-dev npx tsx packages/admin/src/mailctl.ts viewer-key create --label dev`
4. Open `http://127.0.0.1:8787/ui/?api=http://127.0.0.1:8787#key=<viewer key>`.

The API reads the same variables as the Lambda (`FLEET_KEY_REQUIRED`, `PUBLIC_REPOS`, `AUTO_CAPABILITIES`, `RETENTION_DAYS`). Mail bodies large enough to have been stored in S3 show a placeholder, because there's no S3 locally.

### Releasing to npm

Bump `version` in `packages/dist/package.json`, commit, then tag and push:
`git tag v<version> && git push origin v<version>`. The publish workflow
tests, builds, smoke-tests the bins, and **stages**
`@critical-labs/agent-identity` and then the `@critical-labs/agent-identity-mcp`
npx wrapper on npm — each version is uploaded non-public and goes live only
when a maintainer approves it on npmjs.com (approve the main package first; the
wrapper depends on it) (or with
`npm stage list @critical-labs/agent-identity` then
`npm stage approve <stage-id> --otp <code>` — the `npm stage` command
needs npm ≥ 11.15 / Node ≥ 22.14; older npm reports "Unknown command").
The `NPM_TOKEN` repository
secret is a granular **stage-only** token (rotate before it expires; the
current one expires 2026-12-21), so a leaked token can never push a version
live without a 2FA'd human approval.

**First publish of a new package (one-time bootstrap).** Staged publishing
only works for packages that already exist on the registry, and a
stage-only token rejects plain `npm publish` — so the tag flow above cannot
create a brand-new package. A maintainer bootstraps each new package once,
locally, with their own 2FA'd npm login (not the CI token):

```bash
npm login                     # maintainer account with publish rights on the org
cd packages/dist && npm publish --access public   # prepack builds; OTP prompted
cd ../mcp-shim  && npm publish --access public    # wrapper second — it depends on the first
```

The bootstrap version carries no provenance (later CI-staged versions do).
After bootstrapping, do not tag the bootstrapped version — staging an
already-published version fails; the tag flow starts with the next release.

## Security model

**Signature authentication.** Every API call is signed with the agent's Ed25519 private key over the concatenation of HTTP method, path, timestamp, and body hash (HTTP Message Signatures style). The server resolves the public key from the request header, looks up the agent, and verifies the signature. There are no bearer tokens. Timestamp skew tolerance is ±5 minutes; a revoked agent's signatures are refused with 403.

**Isolation by construction.** No API endpoint accepts an agent ID or address as a parameter — the caller is always resolved from the signature. It is impossible to read another agent's mail through the API; the isolation is structural, not access-control policy.

**No delete operations; 90-day TTL.** Delete endpoints do not exist for anyone, including the operator's API. Email records leave DynamoDB only via a 90-day TTL; raw MIME in S3 expires on the same schedule via a lifecycle rule. The admin CLI can revoke an agent (refusing its future signatures) but cannot delete its mail records through the API.

**IDs never reused.** Numeric agent IDs are permanent even after revocation. A revoked agent's address may back a live external account such as GitHub; reassigning that numeric ID would hand a new agent control over that account's email recovery path. Revoked agents remain as tombstones.

**Operator visibility caveat.** The isolation described above is an API-layer boundary between agents. Anyone with direct AWS account access can read S3 and DynamoDB without going through the API. This is not encryption against the operator; it is isolation between agents sharing the same deployment.
