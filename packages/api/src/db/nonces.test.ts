import { createHash } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { NoncesRepo } from "./nonces.js";

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new NoncesRepo(ddb as never, "tbl");

beforeEach(() => ddb.reset());

describe("NoncesRepo", () => {
  it("recordOnce writes PK/SK/expiresAt and returns true on first call", async () => {
    ddb.on(PutCommand).resolves({});
    const result = await repo.recordOnce("fp123", "sig-abc");

    expect(result).toBe(true);

    const calls = ddb.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);

    const item = calls[0].args[0].input.Item!;
    expect(item.PK).toBe("NONCE#fp123");

    const sigHash = createHash("sha256").update("sig-abc").digest("base64url");
    expect(item.SK).toBe(`SIG#${sigHash}`);

    const now = Math.floor(Date.now() / 1000);
    expect(item.expiresAt).toBeGreaterThanOrEqual(now + 599);
    expect(item.expiresAt).toBeLessThanOrEqual(now + 601);

    const input = calls[0].args[0].input;
    expect(input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("returns false when DynamoDB rejects with ConditionalCheckFailedException (replay)", async () => {
    ddb.on(PutCommand).rejects(
      new ConditionalCheckFailedException({ message: "conditional check failed", $metadata: {} }),
    );
    const result = await repo.recordOnce("fp123", "sig-abc");
    expect(result).toBe(false);
  });

  it("propagates unexpected errors", async () => {
    ddb.on(PutCommand).rejects(new Error("network failure"));
    await expect(repo.recordOnce("fp123", "sig-abc")).rejects.toThrow("network failure");
  });
});
