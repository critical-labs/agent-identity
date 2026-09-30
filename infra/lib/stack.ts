import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
} from "aws-cdk-lib";
import { CfnStage, CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { ReceiptRuleSet } from "aws-cdk-lib/aws-ses";
import * as actions from "aws-cdk-lib/aws-ses-actions";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export interface AgentIdentityStackProps extends StackProps {
  domain: string;
  retentionDays?: number;
  /** Default-stage throttling. Every request costs a Lambda invoke plus a
   *  DynamoDB nonce write, so an unthrottled endpoint is a denial-of-wallet
   *  surface for whoever self-hosts this stack — protection is on by default
   *  and only tunable, not removable, from props. */
  apiThrottle?: { rateLimit: number; burstLimit: number };
}

export class AgentIdentityStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentIdentityStackProps) {
    super(scope, id, props);
    const retentionDays = props.retentionDays ?? 90;

    const table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const bucket = new Bucket(this, "Mail", {
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { prefix: "raw/", expiration: Duration.days(retentionDays) },
        { prefix: "bodies/", expiration: Duration.days(retentionDays) },
        { prefix: "unmatched/", expiration: Duration.days(7) },
      ],
    });

    const commonEnv = {
      TABLE_NAME: table.tableName,
      BUCKET_NAME: bucket.bucketName,
      MAIL_DOMAIN: props.domain,
      RETENTION_DAYS: String(retentionDays),
    };
    const fnDefaults = {
      runtime: Runtime.NODEJS_20_X,
      bundling: {
        format: OutputFormat.ESM,
        // mailparser (CJS) calls require("stream") at module scope; esbuild's
        // ESM output stubs require() with a throw unless we provide a real one.
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      environment: commonEnv,
    };

    const ingestFn = new NodejsFunction(this, "Ingest", {
      ...fnDefaults,
      entry: pkg("ingest/src/handler.ts"),
      timeout: Duration.seconds(30),
      environment: {
        ...commonEnv,
        // Sender domains delivered unflagged; everything else is stored with
        // unsolicited: true. Comma-separated, subdomains match implicitly.
        MAIL_SENDER_ALLOWLIST:
          this.node.tryGetContext("senderAllowlist") ?? "github.com,gitlab.com",
      },
    });
    table.grantReadWriteData(ingestFn);
    bucket.grantReadWrite(ingestFn);

    const apiFn = new NodejsFunction(this, "Api", {
      ...fnDefaults,
      entry: pkg("api/src/lambda.ts"),
      // The fleet routes scan the whole table (activity.ts scanAll). At the
      // Lambda defaults (128 MB, 3s) those scans outgrew the timeout as the
      // table grew, and API Gateway turned every timeout into a 500. Memory
      // also buys CPU on Lambda; stay well under API Gateway's 30s limit.
      timeout: Duration.seconds(10),
      memorySize: 512,
      environment: {
        ...commonEnv,
        // Repos the UNAUTHENTICATED public fleet tier may mention:
        // comma-separated "owner/repo" or "owner/*" patterns, matched
        // case-insensitively on exact segments. Defaults to EMPTY — an empty
        // allowlist means the public tier shows no forge events at all.
        //
        // HAZARD — these are NAME patterns, not a visibility check: an
        // "owner/*" wildcard also covers every PRIVATE repo that owner has
        // now or gains later. The name allowlist is therefore only one of
        // two gates: the public tier additionally requires the proxy's
        // attestation-time stamp detail.visibility === "public" (the repo's
        // actual visibility, read from the forge) before a forge event is
        // shown. Events without the stamp — including everything attested
        // before stamping existed — are never shown publicly.
        PUBLIC_REPOS: this.node.tryGetContext("publicRepos") ?? "",
        // OPERATOR DEPLOYMENT POLICY, never an ambient agent power: the
        // comma-separated capability slugs that POST /register may grant at
        // identity BIRTH when the (fleet-key-gated) registration asks for
        // them. Defaults to EMPTY — the feature is off and the admin-key
        // route stays the only grant path. Enabling a slug here trades the
        // per-identity admin ceremony for a deployment-wide policy: anyone
        // holding the fleet key can then mint identities born with these
        // capabilities, so list only what every fleet-key holder may have.
        AUTO_CAPABILITIES: this.node.tryGetContext("autoCapabilities") ?? "",
      },
    });
    table.grantReadWriteData(apiFn);
    bucket.grantRead(apiFn);

    const httpApi = new HttpApi(this, "HttpApi", {
      defaultIntegration: new HttpLambdaIntegration("ApiInt", apiFn),
      // Browser surfaces (the fleet dashboard, the public fleet view) fetch
      // cross-origin; x-viewer-key on GETs triggers preflight. Writes stay
      // browser-hostile on purpose: only GET is allowed cross-origin.
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [CorsHttpMethod.GET],
        allowHeaders: ["content-type", "x-viewer-key"],
        maxAge: Duration.hours(1),
      },
    });
    // The L2 HttpApi's auto-created $default stage exposes no throttle prop;
    // set it on the L1. Applies to every route, /forge/* included.
    const throttle = props.apiThrottle ?? { rateLimit: 25, burstLimit: 50 };
    (httpApi.defaultStage!.node.defaultChild as CfnStage).defaultRouteSettings = {
      throttlingRateLimit: throttle.rateLimit,
      throttlingBurstLimit: throttle.burstLimit,
    };

    const proxyFn = new NodejsFunction(this, "Proxy", {
      ...fnDefaults,
      entry: pkg("proxy/src/lambda.ts"),
      // Forge operations make several sequential upstream calls (e.g. provision:
      // list/create service account, add member, mint PAT, store in SSM), well
      // beyond the 3s Lambda default. Cap under the API Gateway 30s limit.
      timeout: Duration.seconds(29),
      environment: {
        ...commonEnv,
        FORGE_GITHUB_FORK_OWNER: this.node.tryGetContext("githubForkOwner") ?? "",
      },
    });
    table.grantReadWriteData(proxyFn);
    proxyFn.addToRolePolicy(new PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/agent-identity/forge/*`],
    }));
    proxyFn.addToRolePolicy(new PolicyStatement({
      actions: ["ssm:PutParameter"],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/agent-identity/forge/gitlab/pat/*`,
      ],
    }));
    httpApi.addRoutes({
      path: "/forge/{proxy+}",
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration("ProxyInt", proxyFn),
    });

    const rules = new ReceiptRuleSet(this, "Rules", {
      rules: [{
        recipients: [props.domain],
        scanEnabled: true,
        actions: [
          new actions.S3({ bucket, objectKeyPrefix: "raw/" }),
          new actions.Lambda({ function: ingestFn }),
        ],
      }],
    });

    // Account-level cost alarm: 80% actual and 100% forecast of the monthly
    // cap email the operator. Opt-in via budgetEmail context or BUDGET_EMAIL
    // env (kept out of argv/repo — the address is personal data). Covers the
    // whole account, which is the protective reading for a dedicated account.
    const budgetEmail = this.node.tryGetContext("budgetEmail") ?? process.env.BUDGET_EMAIL;
    if (budgetEmail) {
      const budgetUsd = Number(this.node.tryGetContext("budgetUsd") ?? 25);
      if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) throw new Error("budgetUsd must be a positive number");
      new CfnBudget(this, "CostBudget", {
        budget: {
          budgetName: "agent-identity-monthly",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: budgetUsd, unit: "USD" },
        },
        notificationsWithSubscribers: [
          {
            notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
            subscribers: [{ subscriptionType: "EMAIL", address: budgetEmail }],
          },
          {
            notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
            subscribers: [{ subscriptionType: "EMAIL", address: budgetEmail }],
          },
        ],
      });
    }

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "ReceiptRuleSetName", { value: rules.receiptRuleSetName });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "MxRecord", {
      value: `${props.domain} MX 10 inbound-smtp.${this.region}.amazonaws.com`,
    });
  }
}
