# GitHub Actions AWS Deployment — Design

**Goal:** Deploy the agent-identity CDK stack to AWS from GitHub Actions, since the development machine has no AWS credentials.

**Decisions (user-approved):**
- AWS auth: GitHub OIDC federation into an IAM role — no long-lived secrets in GitHub.
- Triggers: `workflow_dispatch` (manual) + `push` to `main`.
- Configuration: GitHub repository variables (`MAIL_DOMAIN`, `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`).
- OIDC provisioning: committed CloudFormation bootstrap template, run once with admin credentials.
- Pipeline shape: two jobs (`test` → `deploy`) with a protected `production` environment.

## Files

| File | Purpose |
|---|---|
| `.github/workflows/deploy.yml` | Test + deploy pipeline |
| `infra/github-oidc.yml` | One-time CloudFormation bootstrap: OIDC provider + deploy role |
| `README.md` | New "CI/CD setup" section |

## Workflow: `.github/workflows/deploy.yml`

**Triggers:** `workflow_dispatch`, `push` to `main`.

**Concurrency:** `concurrency: { group: deploy, cancel-in-progress: false }` — overlapping CloudFormation updates queue rather than collide; in-flight deploys are never cancelled.

**Job `test`** (no AWS credentials, runs on every trigger):
1. Checkout, setup pnpm + Node 20, `pnpm install --frozen-lockfile`.
2. `pnpm vitest run` (48 tests).
3. `npx tsc --noEmit -p tsconfig.base.json`.
4. `pnpm exec cdk synth -c domain=ci.invalid > /dev/null` from `infra/` — synth requires no credentials and proves the app still synthesizes. `ci.invalid` is a reserved TLD, unambiguously a placeholder.

**Job `deploy`** (`needs: test`; `environment: production`; `permissions: { id-token: write, contents: read }`; skipped never — runs on both triggers):
1. **Guard step:** fail fast with an actionable message if `vars.MAIL_DOMAIN`, `vars.AWS_REGION`, or `vars.AWS_DEPLOY_ROLE_ARN` is unset.
2. Checkout + pnpm install (fresh runner; jobs don't share workspaces).
3. `aws-actions/configure-aws-credentials@v4` with `role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}`, `aws-region: ${{ vars.AWS_REGION }}`.
4. `pnpm exec cdk deploy --require-approval never -c domain=${{ vars.MAIL_DOMAIN }} --outputs-file outputs.json` from `infra/`.
5. `aws ses set-active-receipt-rule-set --rule-set-name <ReceiptRuleSetName from outputs.json>` — automates the one post-deploy step the pipeline can perform. Idempotent; note that SES allows only one active rule set per account/region, so this assumes the account is dedicated (or at least that this rule set should win).
6. **Job summary:** write `ApiUrl`, `MxRecord`, and the remaining manual steps (publish MX DNS record, verify the SES domain identity/DKIM, create a fleet key with `mailctl`) to `$GITHUB_STEP_SUMMARY`.

## Bootstrap template: `infra/github-oidc.yml`

CloudFormation template, run once with admin credentials (CloudShell or console upload):

- **OIDC provider:** `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`. Created conditionally via a `CreateOidcProvider` parameter (default `true`) since an account can only have one provider per URL.
- **Deploy role:** trust policy pinned to `repo:critical-labs/agent-identity:environment:production` (parameterized as `GitHubOrg`/`GitHubRepo`/`EnvironmentName` with those defaults). Permissions policy:
  - `sts:AssumeRole` on `arn:aws:iam::<account>:role/cdk-*` — CDK v2 deploys through its bootstrap roles, so we do not hand-enumerate service permissions.
  - `ses:SetActiveReceiptRuleSet`, `ses:DescribeReceiptRuleSet` on `*` (SES rule-set APIs do not support resource-level scoping).
- **Output:** `DeployRoleArn` — pasted into the `AWS_DEPLOY_ROLE_ARN` repo variable.

## README additions ("CI/CD setup")

1. Run `cdk bootstrap` in the target account/region (CloudShell one-liner given).
2. Deploy `infra/github-oidc.yml` (`aws cloudformation deploy` one-liner given), note the `DeployRoleArn` output.
3. Create the `production` environment in repo Settings → Environments (optionally add required reviewers for deploy approval).
4. Set repo variables: `MAIL_DOMAIN`, `AWS_REGION` (must be an SES-inbound region: us-east-1, us-west-2, or eu-west-1), `AWS_DEPLOY_ROLE_ARN`.
5. Dispatch the workflow; then complete the manual steps from the job summary.

## Error handling

- Missing repo variables → guard step fails with a message naming the variable and where to set it.
- OIDC assume-role failure → surfaced by `configure-aws-credentials`; README troubleshooting note points at trust-policy repo/environment mismatch as the usual cause.
- `cdk deploy` failure → CloudFormation rolls back; job fails; no rule-set activation runs (steps are sequential).
- Overlapping runs → serialized by the concurrency group.

## Testing

Full E2E requires a real AWS account, so verification is layered:
1. `actionlint` on `deploy.yml` (install locally if absent).
2. `cfn-lint` (or `aws cloudformation validate-template` once credentials exist) on `github-oidc.yml`.
3. The `test` job's steps run locally today (vitest, tsc, synth) — they are the same commands.
4. First real validation is a `workflow_dispatch` run after the user performs the bootstrap; the spec explicitly accepts that OIDC federation and `cdk deploy` cannot be exercised before then.

## Out of scope

- PR CI (`ci.yml` on pull requests) — easy follow-up, not part of this request.
- Multiple environments/stages — single production stack only.
- Automating DNS (MX record) or SES domain verification — requires access to the user's DNS provider.
