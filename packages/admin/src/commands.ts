import {
  DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomBytes } from "node:crypto";

export async function createFleetKey(
  ddb: DynamoDBDocumentClient, table: string, label: string,
): Promise<string> {
  const key = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");
  await ddb.send(new PutCommand({
    TableName: table,
    Item: { PK: `FLEET#${hash}`, SK: "FLEET", label, createdAt: new Date().toISOString() },
  }));
  return key;
}

export interface AgentRow {
  fingerprint: string;
  agentId: string;
  address: string;
  status: string;
}

export async function listAgents(
  ddb: DynamoDBDocumentClient, table: string,
): Promise<AgentRow[]> {
  const res = await ddb.send(new ScanCommand({
    TableName: table,
    FilterExpression: "SK = :sk",
    ExpressionAttributeValues: { ":sk": "AGENT" },
  }));
  return (res.Items ?? []).map((i) => ({
    fingerprint: (i.PK as string).slice("AGENT#".length),
    agentId: i.agentId as string,
    address: i.address as string,
    status: i.status as string,
  }));
}

export async function revokeAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
): Promise<void> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: table, Key: { PK: `ADDR#${agentId}`, SK: "ADDR" },
  }));
  if (!Item) throw new Error(`no agent with id ${agentId}`);
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `AGENT#${Item.fingerprint}`, SK: "AGENT" },
    UpdateExpression: "SET #s = :r",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":r": "revoked" },
  }));
}
