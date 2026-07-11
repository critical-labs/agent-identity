import type { AgentIdentity } from "@agent-identity/shared";
import {
  DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomInt } from "node:crypto";

export interface AgentRecord extends AgentIdentity {
  publicKey: string;
  status: "active" | "revoked";
  createdAt: string;
  capabilities?: string[]; // operator-set via mailctl; registration never sets it
}

export class AgentsRepo {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly domain: string,
  ) {}

  async getByFingerprint(fp: string): Promise<AgentRecord | undefined> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `AGENT#${fp}`, SK: "AGENT" },
    }));
    return Item as AgentRecord | undefined;
  }

  async getByLocalPart(agentId: string): Promise<AgentRecord | undefined> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `ADDR#${agentId}`, SK: "ADDR" },
    }));
    if (!Item) return undefined;
    return this.getByFingerprint(Item.fingerprint as string);
  }

  async register(publicKeySpkiBase64: string, fp: string): Promise<AgentIdentity> {
    const existing = await this.getByFingerprint(fp);
    if (existing) return { agentId: existing.agentId, address: existing.address };

    for (let attempt = 0; attempt < 5; attempt++) {
      const agentId = String(randomInt(100000, 1000000));
      const address = `${agentId}@${this.domain}`;
      try {
        await this.ddb.send(new TransactWriteCommand({
          TransactItems: [
            { Put: {
              TableName: this.table,
              Item: { PK: `ADDR#${agentId}`, SK: "ADDR", fingerprint: fp },
              ConditionExpression: "attribute_not_exists(PK)",
            }},
            { Put: {
              TableName: this.table,
              Item: {
                PK: `AGENT#${fp}`, SK: "AGENT", agentId, address,
                publicKey: publicKeySpkiBase64, status: "active",
                createdAt: new Date().toISOString(),
              },
              ConditionExpression: "attribute_not_exists(PK)",
            }},
          ],
        }));
        return { agentId, address };
      } catch (err) {
        if ((err as Error).name !== "TransactionCanceledException") throw err;
        // Either addr collision (retry new id) or concurrent register of the
        // same key (return what won).
        const winner = await this.getByFingerprint(fp);
        if (winner) return { agentId: winner.agentId, address: winner.address };
      }
    }
    throw new Error("could not allocate agent id after 5 attempts");
  }

  async verifyFleetKey(fleetKey: string): Promise<boolean> {
    const hash = createHash("sha256").update(fleetKey).digest("hex");
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `FLEET#${hash}`, SK: "FLEET" },
    }));
    return Item !== undefined;
  }

  async revoke(fp: string): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: this.table,
      Key: { PK: `AGENT#${fp}`, SK: "AGENT" },
      UpdateExpression: "SET #s = :r",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":r": "revoked" },
    }));
  }
}
