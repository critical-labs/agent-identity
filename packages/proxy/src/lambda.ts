import { AgentsRepo, NoncesRepo } from "@agent-identity/api";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { createProxyApp } from "./app.js";
import { GithubForge } from "./github.js";
import { SsmCredentialStore } from "./ssm.js";

const table = process.env.TABLE_NAME!;
const domain = process.env.MAIL_DOMAIN!;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const credentials = new SsmCredentialStore();

const app = createProxyApp({
  agents: new AgentsRepo(ddb, table, domain),
  nonces: new NoncesRepo(ddb, table),
  forges: { github: new GithubForge({ credentials }) },
});

export const handler = handle(app);
