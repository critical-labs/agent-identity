# agent-identity

## What this is

agent-identity gives AI agents a persistent, verifiable identity whose first capability is a receive-only email mailbox backed by AWS SES. An agent's identity is an Ed25519 keypair generated client-side on first use and stored at `~/.config/agent-identity/<profile>.json`. Registration assigns a permanent random numeric ID; the mailbox address is `<id>@<domain>` — numbers only, no names. Identity and mailbox are born together and are immutable. The driving use case is GitHub onboarding: an agent needs an email address to create a GitHub account so it can author commits, open pull requests, and receive notifications. The project is open-source and self-hostable; the reference deployment is private, gated by a fleet key so only the operator's own agents may register.

## Quick start (agent)

Add the MCP server to your Claude (or compatible) client config:

```json
{
  "mcpServers": {
    "agent-identity": {
      "command": "npx",
      "args": ["tsx", "/path/to/agent-identity/packages/mcp/src/server.ts"],
      "env": {
        "AGENT_IDENTITY_API_URL": "https://<api-id>.execute-api.<region>.amazonaws.com",
        "AGENT_IDENTITY_FLEET_KEY": "<from mailctl fleet-key create>",
        "AGENT_IDENTITY_PROFILE": "default"
      }
    }
  }
}
```

Call `ensure_identity` at the start of every session — it loads or creates your keypair, registers with the server (idempotent), and returns your `agentId` and `address`. The other tools are `list_emails` (returns summaries with id, from, subject, receivedAt), `get_email` (returns full text body and extracted links for a given id), and `wait_for_email` (polls until a matching message arrives; when the timeout elapses it returns `{timedOut: true}` as a clean result, not an error). Following links in retrieved emails is the agent's own job — the server does not fetch URLs.

## Deploy (operator)

SES inbound email is only available in **us-east-1**, **us-west-2**, and **eu-west-1**. Deploy your stack into one of those regions.

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Deploy the CDK stack, substituting your domain name:
   ```bash
   cd infra && npx cdk deploy -c domain=mail.example.com
   ```
   The stack outputs the API URL, the MX record value, and the SES domain verification records. Note the `MxRecord` output.

3. Verify your domain in SES and add DNS records. Create the SES email identity for your domain:
   ```bash
   aws sesv2 create-email-identity --email-identity mail.example.com
   ```
   Then add the DKIM CNAME records and the domain verification TXT record that the SES console (or the above command's output) provides. Add an MX record for your domain pointing to the value from the stack's `MxRecord` output.

4. Activate the SES receipt rule set. CDK creates the rule set but does not activate it — you must do this manually:
   ```bash
   aws ses set-active-receipt-rule-set --rule-set-name <ReceiptRuleSetName from stack output>
   ```

5. Mint a fleet key so agents can register:
   ```bash
   AGENT_IDENTITY_TABLE=<TableName output> npx tsx packages/admin/src/mailctl.ts fleet-key create --label <label>
   ```
   Give the resulting key to agents via the `AGENT_IDENTITY_FLEET_KEY` environment variable.

Other admin operations (listing agents, revoking an identity) use the same `mailctl` CLI with operator AWS credentials directly against DynamoDB. There is no admin HTTP API.

## CI/CD (GitHub Actions)

`.github/workflows/deploy.yml` tests and deploys the stack on every push to `main`, or on demand from the Actions tab (`workflow_dispatch`). Deploys authenticate to AWS via GitHub OIDC — no long-lived AWS keys are stored in GitHub.

One-time setup (run in CloudShell, or any shell with admin credentials, in your target region — SES inbound requires us-east-1, us-west-2, or eu-west-1):

1. Bootstrap the CDK toolkit:
   ```bash
   npx aws-cdk@2 bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION
   ```

2. Create the OIDC provider and deploy role (add `CreateOidcProvider=false` to the parameter overrides if the account already has a GitHub OIDC provider):
   ```bash
   curl -sO https://raw.githubusercontent.com/critical-labs/agent-identity/main/infra/github-oidc.yml
   aws cloudformation deploy --template-file github-oidc.yml \
     --stack-name agent-identity-github-oidc --capabilities CAPABILITY_NAMED_IAM
   aws cloudformation describe-stacks --stack-name agent-identity-github-oidc \
     --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
   ```

3. In repo **Settings → Environments**, create an environment named `production` (optionally require reviewers to gate deploys).

4. In repo **Settings → Secrets and variables → Actions → Variables**, set:
   - `MAIL_DOMAIN` — the mail domain, e.g. `mail.example.com`
   - `AWS_REGION` — e.g. `us-east-1`
   - `AWS_DEPLOY_ROLE_ARN` — the `DeployRoleArn` output from step 2

5. Run the **deploy** workflow from the Actions tab. The job summary lists the stack outputs and the remaining manual steps (DNS MX record, SES domain verification, fleet key). The workflow activates the SES receipt rule set automatically.

If the deploy job fails at `configure-aws-credentials`, the usual cause is a trust-policy mismatch: the role only trusts `repo:critical-labs/agent-identity:environment:production`, so the environment name and repository must match exactly.

## GitHub onboarding flow

GitHub blocks automated signups — their Terms of Service require human account creation and a CAPTCHA enforces it. The flow is therefore human-assisted at exactly one step:

1. The agent calls `ensure_identity` and receives its permanent address, for example `482913@mail.example.com`.
2. The agent asks its human to complete the GitHub signup form using that address. The human handles ToS acceptance and the CAPTCHA — this is the one step that cannot be automated.
3. GitHub sends a verification email to the agent's mailbox. The agent calls `wait_for_email` (with `subjectContains` matching GitHub's subject line), then `get_email` to retrieve the full message and surface the verification link. The agent or human follows the link to confirm the account.
4. The account is live. The agent's human configures credentials or a Personal Access Token as they see fit. Ongoing GitHub notification email flows to the agent's mailbox and is readable via `list_emails` / `get_email`.

## Security model

**Signature authentication.** Every API call is signed with the agent's Ed25519 private key over the concatenation of HTTP method, path, timestamp, and body hash (HTTP Message Signatures style). The server resolves the public key from the request header, looks up the agent, and verifies the signature. There are no bearer tokens. Timestamp skew tolerance is ±5 minutes; a revoked agent's signatures are refused with 403.

**Isolation by construction.** No API endpoint accepts an agent ID or address as a parameter — the caller is always resolved from the signature. It is impossible to read another agent's mail through the API; the isolation is structural, not access-control policy.

**No delete operations; 90-day TTL.** Delete endpoints do not exist for anyone, including the operator's API. Email records leave DynamoDB only via a 90-day TTL; raw MIME in S3 expires on the same schedule via a lifecycle rule. The admin CLI can revoke an agent (refusing its future signatures) but cannot delete its mail records through the API.

**IDs never reused.** Numeric agent IDs are permanent even after revocation. A revoked agent's address may back a live external account such as GitHub; reassigning that numeric ID would hand a new agent control over that account's email recovery path. Revoked agents remain as tombstones.

**Operator visibility caveat.** The isolation described above is an API-layer boundary between agents. Anyone with direct AWS account access can read S3 and DynamoDB without going through the API. This is not encryption against the operator; it is isolation between agents sharing the same deployment.
