import { createHash } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

// Nonce TTL = 2x the auth skew window, so an entry always outlives the
// period in which its signature would still be accepted.
const NONCE_TTL_SECONDS = 600;

export class NoncesRepo {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  /** Records a signature the first time it is seen. Returns false on replay. */
  async recordOnce(fp: string, signature: string): Promise<boolean> {
    const sigHash = createHash("sha256").update(signature).digest("base64url");
    try {
      await this.ddb.send(new PutCommand({
        TableName: this.table,
        Item: {
          PK: `NONCE#${fp}`,
          SK: `SIG#${sigHash}`,
          expiresAt: Math.floor(Date.now() / 1000) + NONCE_TTL_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }));
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}
