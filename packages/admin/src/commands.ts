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
  capabilities: string;
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
    capabilities: ((i.capabilities as string[]) ?? []).join(","),
  }));
}

async function agentKeyByLocalPart(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
): Promise<{ PK: string; SK: string }> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: table, Key: { PK: `ADDR#${agentId}`, SK: "ADDR" },
  }));
  if (!Item) throw new Error(`no agent with id ${agentId}`);
  return { PK: `AGENT#${Item.fingerprint}`, SK: "AGENT" };
}

export async function revokeAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
): Promise<void> {
  const key = await agentKeyByLocalPart(ddb, table, agentId);
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: "SET #s = :r",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":r": "revoked" },
  }));
}

async function setCapabilities(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
  mutate: (caps: Set<string>) => void,
): Promise<void> {
  const key = await agentKeyByLocalPart(ddb, table, agentId);
  const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  const caps = new Set<string>((Item?.capabilities as string[]) ?? []);
  mutate(caps);
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: "SET capabilities = :c",
    ExpressionAttributeValues: { ":c": [...caps].sort() },
  }));
}

export function tagAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string, capability: string,
): Promise<void> {
  return setCapabilities(ddb, table, agentId, (caps) => caps.add(capability));
}

export function untagAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string, capability: string,
): Promise<void> {
  return setCapabilities(ddb, table, agentId, (caps) => caps.delete(capability));
}
