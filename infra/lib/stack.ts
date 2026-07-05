import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
} from "aws-cdk-lib";
import { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
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
      bundling: { format: OutputFormat.ESM },
      environment: commonEnv,
    };

    const ingestFn = new NodejsFunction(this, "Ingest", {
      ...fnDefaults,
      entry: pkg("ingest/src/handler.ts"),
      timeout: Duration.seconds(30),
    });
    table.grantReadWriteData(ingestFn);
    bucket.grantReadWrite(ingestFn);

    const apiFn = new NodejsFunction(this, "Api", {
      ...fnDefaults,
      entry: pkg("api/src/lambda.ts"),
    });
    table.grantReadWriteData(apiFn);
    bucket.grantRead(apiFn);

    const httpApi = new HttpApi(this, "HttpApi", {
      defaultIntegration: new HttpLambdaIntegration("ApiInt", apiFn),
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

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "ReceiptRuleSetName", { value: rules.receiptRuleSetName });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "MxRecord", {
      value: `${props.domain} MX 10 inbound-smtp.${this.region}.amazonaws.com`,
    });
  }
}
