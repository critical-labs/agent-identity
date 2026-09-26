import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { TABLE_KEYS } from "../../packages/shared/src/table.js";
import { AgentIdentityStack, type AgentIdentityStackProps } from "./stack.js";

// Skip Lambda asset bundling — these tests assert on synthesized resources,
// not function code, and bundling would shell out to esbuild per function.
const synth = (props: Partial<AgentIdentityStackProps> = {}, context: Record<string, unknown> = {}) => {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [], ...context } });
  const stack = new AgentIdentityStack(app, "Test", { domain: "mail.example.com", ...props });
  return Template.fromStack(stack);
};

describe("table key schema", () => {
  it("matches the shared TABLE_KEYS the local dev server creates tables from", () => {
    synth().hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: TABLE_KEYS.partitionKey, KeyType: "HASH" },
        { AttributeName: TABLE_KEYS.sortKey, KeyType: "RANGE" },
      ],
      TimeToLiveSpecification: { AttributeName: TABLE_KEYS.ttlAttribute, Enabled: true },
    });
  });
});

describe("cors", () => {
  it("allows browser dashboards to call the API (GET + the read-key headers)", () => {
    synth().hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: {
        AllowOrigins: ["*"],
        AllowMethods: ["GET"],
        AllowHeaders: ["content-type", "x-viewer-key"],
      },
    });
  });
});

describe("api throttling", () => {
  it("throttles the default stage by default", () => {
    synth().hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 25, ThrottlingBurstLimit: 50 },
    });
  });

  it("honors apiThrottle overrides", () => {
    synth({ apiThrottle: { rateLimit: 5, burstLimit: 10 } }).hasResourceProperties(
      "AWS::ApiGatewayV2::Stage",
      { DefaultRouteSettings: { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 } },
    );
  });
});

describe("public fleet repo allowlist", () => {
  it("defaults PUBLIC_REPOS to the empty string — the public tier fails closed", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ PUBLIC_REPOS: "", TABLE_NAME: Match.anyValue() }),
      },
    });
  });

  it("honors the publicRepos context", () => {
    synth({}, { publicRepos: "critical-labs/*,acme/widgets" }).hasResourceProperties(
      "AWS::Lambda::Function",
      {
        Environment: {
          Variables: Match.objectLike({ PUBLIC_REPOS: "critical-labs/*,acme/widgets" }),
        },
      },
    );
  });
});

describe("auto-capabilities policy", () => {
  it("defaults AUTO_CAPABILITIES to the empty string — the feature is off", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ AUTO_CAPABILITIES: "", PUBLIC_REPOS: Match.anyValue() }),
      },
    });
  });

  it("honors the autoCapabilities context", () => {
    synth({}, { autoCapabilities: "github,email" }).hasResourceProperties(
      "AWS::Lambda::Function",
      {
        Environment: {
          Variables: Match.objectLike({ AUTO_CAPABILITIES: "github,email" }),
        },
      },
    );
  });
});

describe("ingest sender allowlist", () => {
  it("defaults MAIL_SENDER_ALLOWLIST to the forge domains", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ MAIL_SENDER_ALLOWLIST: "github.com,gitlab.com" }),
      },
    });
  });

  it("honors the senderAllowlist context", () => {
    synth({}, { senderAllowlist: "example.org,forge.example" }).hasResourceProperties(
      "AWS::Lambda::Function",
      {
        Environment: {
          Variables: Match.objectLike({ MAIL_SENDER_ALLOWLIST: "example.org,forge.example" }),
        },
      },
    );
  });
});

describe("mailbox domain catch-all (issue #114)", () => {
  // A named mailbox's optional --catch-all routes unknown local-parts into it.
  // No SES receipt-rule change is needed for this: the rule's recipient is
  // already the bare domain, which SES treats as a catch-all matching EVERY
  // local-part at that domain. The Lambda already receives mail for unknown
  // local-parts (they are simply dropped today); catch-all is a pure
  // ingest/table concern. This test pins that the recipient stays the domain.
  it("receives all local-parts at the domain (bare-domain recipient = SES catch-all)", () => {
    synth().hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: Match.objectLike({ Recipients: ["mail.example.com"] }),
    });
  });
});

describe("proxy github-app signing SSM grant (issue #120)", () => {
  // The GitHub App params (/agent-identity/forge/github/app-id,
  // installation-id, app-private-key) that the proxy reads to mint an
  // installation token live under /agent-identity/forge/*, so the existing
  // wildcard ssm:GetParameter grant already covers them — no new grant.
  it("grants the proxy ssm:GetParameter on the whole /agent-identity/forge/* subtree", () => {
    synth().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ssm:GetParameter",
            Resource: Match.objectLike({
              "Fn::Join": Match.arrayWith([
                Match.arrayWith([
                  Match.stringLikeRegexp(":parameter/agent-identity/forge/\\*$"),
                ]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  // The SSH signing params — /agent-identity/forge/github/signing-key
  // (SecureString ed25519 key), signing-committer-name, signing-committer-email
  // — that resolveCommitSigner reads to SSH-sign commits (verified=true) also
  // live under /agent-identity/forge/*, so the SAME wildcard covers them with
  // no new grant and no KMS grant (the SecureString uses the AWS-managed SSM
  // key). This guards against anyone narrowing the grant to only the app-*
  // params, which would silently break signing. There must be exactly ONE
  // ssm:GetParameter statement (the wildcard), not a per-parameter list.
  it("covers the signing-key params under the same wildcard — no separate grant needed", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ssm:GetParameter",
            Resource: Match.objectLike({
              "Fn::Join": Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp(":parameter/agent-identity/forge/\\*$")]),
              ]),
            }),
          }),
        ]),
      },
    });
    // No standalone grant scoped to github/signing-key: coverage is the wildcard.
    const policies = t.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap(
      (p) => (p.Properties as { PolicyDocument: { Statement: { Action?: unknown }[] } })
        .PolicyDocument.Statement,
    );
    const getParamStmts = statements.filter((s) => s.Action === "ssm:GetParameter");
    expect(getParamStmts).toHaveLength(1);
  });
});

describe("cost budget", () => {
  it("creates a $25 monthly budget with 80% actual and 100% forecast email alerts when budgetEmail is set", () => {
    const t = synth({}, { budgetEmail: "ops@example.com" });
    t.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 25, Unit: "USD" },
      },
      NotificationsWithSubscribers: [
        {
          Notification: { NotificationType: "ACTUAL", Threshold: 80 },
          Subscribers: [{ SubscriptionType: "EMAIL", Address: "ops@example.com" }],
        },
        {
          Notification: { NotificationType: "FORECASTED", Threshold: 100 },
          Subscribers: [{ SubscriptionType: "EMAIL", Address: "ops@example.com" }],
        },
      ],
    });
  });

  it("creates no budget when no email is configured", () => {
    synth().resourceCountIs("AWS::Budgets::Budget", 0);
  });

  it("honors a budgetUsd override", () => {
    synth({}, { budgetEmail: "ops@example.com", budgetUsd: "40" })
      .hasResourceProperties("AWS::Budgets::Budget", {
        Budget: { BudgetLimit: { Amount: 40, Unit: "USD" } },
      });
  });
});
