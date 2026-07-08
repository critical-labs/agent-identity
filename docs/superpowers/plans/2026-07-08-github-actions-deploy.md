# GitHub Actions AWS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub Actions pipeline that tests and deploys the agent-identity CDK stack to AWS via OIDC, plus the one-time CloudFormation bootstrap it depends on.

**Architecture:** One workflow with two jobs — `test` (no credentials: vitest, tsc, cdk synth) and `deploy` (`environment: production`, assumes an IAM role via GitHub OIDC, runs `cdk deploy`, activates the SES receipt rule set, writes outputs to the job summary). A committed CloudFormation template creates the OIDC provider and deploy role once; all environment-specific values live in GitHub repository variables.

**Tech Stack:** GitHub Actions, aws-actions/configure-aws-credentials@v4, pnpm 9 / Node 20, AWS CDK v2 (already in `infra/`), CloudFormation.

**Spec:** `docs/superpowers/specs/2026-07-08-github-actions-deploy-design.md`

**Repo facts the engineer needs:**
- pnpm workspace; lockfile at repo root (`pnpm-lock.yaml`). Tests: `pnpm vitest run` (48 tests). Type check: `npx tsc --noEmit -p tsconfig.base.json`.
- CDK app lives in `infra/` (`cdk.json` → `npx tsx bin/app.ts`), requires context `-c domain=<mail domain>`. Synth needs no AWS credentials.
- Stack outputs (defined in `infra/lib/stack.ts`): `ApiUrl`, `ReceiptRuleSetName`, `TableName`, `MxRecord`.
- There is no `.github/` directory yet.
- All commits are authored as `critical-agent0` via repo-local git config — just commit normally, do NOT change git config.

---

### Task 1: CloudFormation bootstrap template (`infra/github-oidc.yml`)

**Files:**
- Create: `infra/github-oidc.yml`

- [ ] **Step 1: Write the template**

Note: intrinsic functions use long form (`Fn::Sub`, not `!Sub`) so the file is plain YAML and parseable by any linter.

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: >
  One-time bootstrap for GitHub Actions deploys of agent-identity:
  GitHub OIDC identity provider + IAM role assumable only by the
  production environment of the configured repository.

Parameters:
  GitHubOrg:
    Type: String
    Default: critical-labs
  GitHubRepo:
    Type: String
    Default: agent-identity
  EnvironmentName:
    Type: String
    Default: production
  CreateOidcProvider:
    Type: String
    Default: "true"
    AllowedValues: ["true", "false"]
    Description: >
      An AWS account can hold only one OIDC provider per URL. Set to
      false if token.actions.githubusercontent.com already exists here.

Conditions:
  ShouldCreateProvider:
    Fn::Equals:
      - Ref: CreateOidcProvider
      - "true"

Resources:
  GitHubOidcProvider:
    Type: AWS::IAM::OIDCProvider
    Condition: ShouldCreateProvider
    Properties:
      Url: https://token.actions.githubusercontent.com
      ClientIdList:
        - sts.amazonaws.com
      ThumbprintList:
        - 6938fd4d98bab03faadb97b34396831e3780aea1
        - 1c58a3a8518e8759bf075b76b750d4f2df264fcd

  DeployRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: agent-identity-github-deploy
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Action: sts:AssumeRoleWithWebIdentity
            Principal:
              Federated:
                Fn::If:
                  - ShouldCreateProvider
                  - Ref: GitHubOidcProvider
                  - Fn::Sub: arn:aws:iam::${AWS::AccountId}:oidc-provider/token.actions.githubusercontent.com
            Condition:
              StringEquals:
                token.actions.githubusercontent.com:aud: sts.amazonaws.com
                token.actions.githubusercontent.com:sub:
                  Fn::Sub: repo:${GitHubOrg}/${GitHubRepo}:environment:${EnvironmentName}
      Policies:
        - PolicyName: cdk-deploy
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              # CDK v2 deploys through its bootstrap roles (cdk-*), so we
              # delegate instead of enumerating service permissions.
              - Effect: Allow
                Action: sts:AssumeRole
                Resource:
                  Fn::Sub: arn:aws:iam::${AWS::AccountId}:role/cdk-*
              # SES rule-set activation APIs do not support resource scoping.
              - Effect: Allow
                Action:
                  - ses:SetActiveReceiptRuleSet
                  - ses:DescribeReceiptRuleSet
                Resource: "*"

Outputs:
  DeployRoleArn:
    Description: Paste into the AWS_DEPLOY_ROLE_ARN repository variable.
    Value:
      Fn::GetAtt:
        - DeployRole
        - Arn
```

- [ ] **Step 2: Validate the YAML parses**

Run: `npx -y js-yaml infra/github-oidc.yml > /dev/null && echo YAML-OK`
Expected: `YAML-OK` (js-yaml exits non-zero on parse errors)

- [ ] **Step 3: Commit**

```bash
git add infra/github-oidc.yml
git commit -m "feat(infra): CloudFormation bootstrap for GitHub OIDC deploys"
```

---

### Task 2: Deploy workflow (`.github/workflows/deploy.yml`)

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: deploy

on:
  workflow_dispatch:
  push:
    branches: [main]

concurrency:
  group: deploy
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm vitest run
      - run: npx tsc --noEmit -p tsconfig.base.json
      - name: CDK synth (no credentials)
        working-directory: infra
        run: pnpm exec cdk synth -c domain=ci.invalid > /dev/null

  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment: production
    permissions:
      id-token: write
      contents: read
    steps:
      - name: Check required repository variables
        env:
          MAIL_DOMAIN: ${{ vars.MAIL_DOMAIN }}
          AWS_REGION: ${{ vars.AWS_REGION }}
          AWS_DEPLOY_ROLE_ARN: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
        run: |
          missing=0
          for v in MAIL_DOMAIN AWS_REGION AWS_DEPLOY_ROLE_ARN; do
            if [ -z "$(eval echo "\$$v")" ]; then
              echo "::error::Repository variable $v is not set. Add it under Settings > Secrets and variables > Actions > Variables."
              missing=1
            fi
          done
          exit $missing
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      - name: CDK deploy
        working-directory: infra
        run: >
          pnpm exec cdk deploy --require-approval never
          -c domain=${{ vars.MAIL_DOMAIN }}
          --outputs-file outputs.json
      - name: Activate SES receipt rule set
        working-directory: infra
        run: |
          RULE_SET=$(jq -r 'to_entries[0].value.ReceiptRuleSetName' outputs.json)
          aws ses set-active-receipt-rule-set --rule-set-name "$RULE_SET"
          echo "Activated receipt rule set: $RULE_SET"
      - name: Write job summary
        working-directory: infra
        env:
          MAIL_DOMAIN: ${{ vars.MAIL_DOMAIN }}
        run: |
          API_URL=$(jq -r 'to_entries[0].value.ApiUrl' outputs.json)
          MX_RECORD=$(jq -r 'to_entries[0].value.MxRecord' outputs.json)
          TABLE_NAME=$(jq -r 'to_entries[0].value.TableName' outputs.json)
          cat >> "$GITHUB_STEP_SUMMARY" <<EOF
          ## Deployed

          | Output | Value |
          |---|---|
          | ApiUrl | $API_URL |
          | MxRecord | \`$MX_RECORD\` |
          | TableName | $TABLE_NAME |

          ### Remaining manual steps

          1. Publish the MX record above in your DNS provider.
          2. If not already done, verify the SES domain identity and add its DKIM records: \`aws sesv2 create-email-identity --email-identity $MAIL_DOMAIN\`
          3. Mint a fleet key: \`AGENT_IDENTITY_TABLE=$TABLE_NAME npx tsx packages/admin/src/mailctl.ts fleet-key create --label <label>\`
          EOF
```

Notes for the engineer:
- The guard step uses `eval` on a fixed, hardcoded list of names — no user input is interpolated.
- `jq` and the AWS CLI are preinstalled on `ubuntu-latest` runners.
- `to_entries[0].value` keeps the jq queries independent of the CloudFormation stack name.
- The rule-set activation assumes this account/region has no competing active SES rule set (documented in the spec).

- [ ] **Step 2: Validate the workflow**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/deploy.yml || npx -y js-yaml .github/workflows/deploy.yml > /dev/null && echo WORKFLOW-OK`
Expected: `WORKFLOW-OK` (actionlint output if installed; otherwise YAML parse check)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat(ci): test + OIDC deploy workflow for AWS"
```

---

### Task 3: README "CI/CD" section

**Files:**
- Modify: `README.md` — insert a new section between `## Deploy (operator)` (ends at line 62, just before `## GitHub onboarding flow` at line 63) and `## GitHub onboarding flow`. Line numbers may have drifted; anchor on the headings, not the numbers.

- [ ] **Step 1: Insert the section**

````markdown
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
````

- [ ] **Step 2: Verify structure**

Run: `grep -n "^## " README.md`
Expected: `## CI/CD (GitHub Actions)` appears between `## Deploy (operator)` and `## GitHub onboarding flow`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: CI/CD setup instructions for GitHub Actions deploys"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the same checks the `test` job runs**

```bash
pnpm vitest run
npx tsc --noEmit -p tsconfig.base.json
cd infra && pnpm exec cdk synth -c domain=ci.invalid > /dev/null && echo SYNTH-OK && cd ..
```

Expected: 48/48 tests pass, tsc silent, `SYNTH-OK`.

- [ ] **Step 2: Re-lint both YAML files**

```bash
npx -y js-yaml infra/github-oidc.yml > /dev/null && npx -y js-yaml .github/workflows/deploy.yml > /dev/null && echo YAML-OK
```

Expected: `YAML-OK`

No commit — this task only proves nothing regressed. Pushing to the PR branch is handled by the controller after review, not by this plan.
