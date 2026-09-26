import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { buildDeps } from "./deps.js";

const bucket = process.env.BUCKET_NAME!;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const app = createApp(buildDeps({
  env: process.env,
  ddb,
  readBody: async (key) => {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await res.Body!.transformToString());
  },
}));

export const handler = handle(app);
