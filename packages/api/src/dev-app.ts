import { readFile } from "node:fs/promises";
import { TABLE_KEYS } from "@agent-identity/shared";
import {
  CreateTableCommand, DescribeTableCommand, ResourceNotFoundException, type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createApp, type Deps } from "./app.js";

/** The local dev composition: one origin serving the fleet dashboard at
 *  /ui/ and the API at its normal paths, so the dashboard needs no CORS and
 *  signed requests keep their unprefixed paths.
 *
 *  Order matters. createApp puts signature auth on every non-/fleet path,
 *  and mounting it copies that middleware into this app, so the /ui routes
 *  are registered first and answer before it runs. The CORS middleware
 *  mirrors what API Gateway adds in production (the Lambda app itself only
 *  answers preflights), so a dashboard served from another origin works too. */
export function createDevApp(deps: Deps, { uiFile }: { uiFile: string }): Hono {
  const app = new Hono();
  app.use("*", cors({
    origin: "*",
    allowMethods: ["GET"],
    allowHeaders: ["content-type", "x-viewer-key"],
    maxAge: 3600,
  }));
  app.get("/ui", (c) => c.redirect("/ui/", 301));
  // Read per request: edits to the dashboard show up on reload.
  app.get("/ui/", async (c) => c.html(await readFile(uiFile, "utf8")));
  app.route("/", createApp(deps));
  return app;
}

/** Create the table (from the shared key schema) if it does not exist yet.
 *  Local emulators start empty; the deployed table belongs to CDK. */
export async function ensureTable(client: DynamoDBClient, tableName: string): Promise<"created" | "exists"> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return "exists";
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  await client.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: TABLE_KEYS.partitionKey, AttributeType: "S" },
      { AttributeName: TABLE_KEYS.sortKey, AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: TABLE_KEYS.partitionKey, KeyType: "HASH" },
      { AttributeName: TABLE_KEYS.sortKey, KeyType: "RANGE" },
    ],
  }));
  return "created";
}

/** The dev server must never reach a real table: it refuses to start unless
 *  the SDK is pointed at an explicit (local) DynamoDB endpoint. */
export function assertLocalEndpoint(env: Record<string, string | undefined>): string {
  const endpoint = env.AWS_ENDPOINT_URL_DYNAMODB || env.AWS_ENDPOINT_URL;
  if (!endpoint) {
    throw new Error(
      "pnpm dev needs a local DynamoDB: set AWS_ENDPOINT_URL_DYNAMODB (e.g. http://127.0.0.1:8000). " +
      "Refusing to start without one so the dev server can never touch a real table.",
    );
  }
  return endpoint;
}
