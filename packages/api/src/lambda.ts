import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { AgentsRepo } from "./db/agents.js";
import { EmailsRepo } from "./db/emails.js";

const table = process.env.TABLE_NAME!;
const domain = process.env.MAIL_DOMAIN!;
const bucket = process.env.BUCKET_NAME!;
const retentionDays = Number(process.env.RETENTION_DAYS ?? "90");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const app = createApp({
  agents: new AgentsRepo(ddb, table, domain),
  emails: new EmailsRepo(ddb, table, retentionDays),
  readBody: async (key) => {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await res.Body!.transformToString());
  },
  fleetKeyRequired: process.env.FLEET_KEY_REQUIRED !== "false",
});

export const handler = handle(app);
