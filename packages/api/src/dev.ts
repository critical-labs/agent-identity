// Local dev server: the API and the fleet dashboard on one loopback port,
// against a local DynamoDB (DynamoDB Local). See README "Local development".
//
//   AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:8000 AWS_REGION=us-east-1 \
//   AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
//   TABLE_NAME=agent-identity-dev MAIL_DOMAIN=mail.localhost pnpm dev
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { serve } from "@hono/node-server";
import { buildDeps } from "./deps.js";
import { assertLocalEndpoint, createDevApp, ensureTable } from "./dev-app.js";

const endpoint = assertLocalEndpoint(process.env);
const port = Number(process.env.PORT ?? "8787");
const uiFile = fileURLToPath(new URL("../../dist/fleet/index.html", import.meta.url));

// The SDK reads the endpoint from AWS_ENDPOINT_URL[_DYNAMODB] itself.
const client = new DynamoDBClient({});
const deps = buildDeps({
  env: process.env,
  ddb: DynamoDBDocumentClient.from(client),
  // Only oversized bodies live in S3, and there is no S3 locally.
  readBody: async () => ({ text: "[stored in S3 — not available in the local dev server]", links: [] }),
});

const table = process.env.TABLE_NAME!;
console.log(`[dev] table ${table} ${await ensureTable(client, table)} at ${endpoint}`);

serve({ fetch: createDevApp(deps, { uiFile }).fetch, hostname: "127.0.0.1", port }, (info) => {
  const origin = `http://127.0.0.1:${info.port}`;
  console.log(`[dev] API on ${origin}`);
  console.log(`[dev] dashboard: ${origin}/ui/?api=${origin}#key=<viewer key>`);
});
