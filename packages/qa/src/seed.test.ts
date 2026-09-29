import { TABLE_KEYS } from "@agent-identity/api";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneDb } from "./dynamodb-local.js";
import { createSeed } from "./seed.js";

const raw = mockClient(DynamoDBClient);
const doc = mockClient(DynamoDBDocumentClient);
beforeEach(() => {
  raw.reset();
  doc.reset();
  raw.on(DescribeTableCommand).rejects(new ResourceNotFoundException({ message: "no table", $metadata: {} }));
  raw.on(CreateTableCommand).resolves({});
});

const db: PaneDb = { endpoint: "http://127.0.0.1:50123", tableName: "agent-identity-qa", region: "us-east-1" };
const paneRef = { role: "base" as const };
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ PK: `AGENT#fp${i}`, SK: "AGENT", agentId: String(100000 + i) }));
const written = () => doc.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!["agent-identity-qa"]);

describe("createSeed", () => {
  it("declares the QA table as its one database", () => {
    expect(createSeed({ snapshot: async () => [] }).databases).toEqual(["agent-identity-qa"]);
  });

  it("creates the pane table from the shared schema before writing", async () => {
    // One log across both mocked clients, in the order the calls were made.
    const calls: string[] = [];
    raw.on(DescribeTableCommand).callsFake(async () => {
      calls.push("DescribeTable");
      throw new ResourceNotFoundException({ message: "no table", $metadata: {} });
    });
    raw.on(CreateTableCommand).callsFake(async () => {
      calls.push("CreateTable");
      return {};
    });
    doc.on(BatchWriteCommand).callsFake(async () => {
      calls.push("BatchWrite");
      return {};
    });
    await createSeed({ snapshot: async () => items(30) }).seedPane({ paneRef, db, databases: ["agent-identity-qa"] });
    expect(calls).toEqual(["DescribeTable", "CreateTable", "BatchWrite", "BatchWrite"]);

    const create = raw.commandCalls(CreateTableCommand)[0].args[0].input;
    expect(create.TableName).toBe("agent-identity-qa");
    expect(create.KeySchema).toEqual([
      { AttributeName: TABLE_KEYS.partitionKey, KeyType: "HASH" },
      { AttributeName: TABLE_KEYS.sortKey, KeyType: "RANGE" },
    ]);
  });

  it("writes the snapshot in batches of 25", async () => {
    doc.on(BatchWriteCommand).resolves({});
    const snapshot = items(60);
    await createSeed({ snapshot: async () => snapshot }).seedPane({ paneRef, db, databases: ["agent-identity-qa"] });
    expect(written().map((batch) => batch.length)).toEqual([25, 25, 10]);
    expect(written().flat().map((r) => r.PutRequest!.Item)).toEqual(snapshot);
  });

  it("writes nothing for an empty snapshot", async () => {
    await createSeed({ snapshot: async () => [] }).seedPane({ paneRef, db, databases: [] });
    expect(doc.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it("retries unprocessed items, with growing backoff, until they land", async () => {
    const snapshot = items(3);
    doc.on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { "agent-identity-qa": [{ PutRequest: { Item: snapshot[1] } }, { PutRequest: { Item: snapshot[2] } }] } })
      .resolvesOnce({ UnprocessedItems: { "agent-identity-qa": [{ PutRequest: { Item: snapshot[2] } }] } })
      .resolves({ UnprocessedItems: {} });
    const sleepFn = vi.fn(async (_ms: number) => {});
    await createSeed({ snapshot: async () => snapshot, sleepFn }).seedPane({ paneRef, db, databases: [] });
    expect(written()).toEqual([
      snapshot.map((Item) => ({ PutRequest: { Item } })),
      [{ PutRequest: { Item: snapshot[1] } }, { PutRequest: { Item: snapshot[2] } }],
      [{ PutRequest: { Item: snapshot[2] } }],
    ]);
    const delays = sleepFn.mock.calls.map((c) => c[0]);
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });

  it("fails after a bounded number of attempts", async () => {
    const snapshot = items(2);
    doc.on(BatchWriteCommand).resolves({ UnprocessedItems: { "agent-identity-qa": [{ PutRequest: { Item: snapshot[0] } }] } });
    const seed = createSeed({ snapshot: async () => snapshot, sleepFn: async () => {}, maxAttempts: 4 });
    await expect(seed.seedPane({ paneRef, db, databases: [] })).rejects.toThrow(/1 item\(s\) still unprocessed after 4 attempts/);
    expect(doc.commandCalls(BatchWriteCommand)).toHaveLength(4);
  });

  it("loads the snapshot through the shared loader on every pane", async () => {
    doc.on(BatchWriteCommand).resolves({});
    const snapshot = vi.fn(async () => items(1));
    const seed = createSeed({ snapshot });
    await seed.seedPane({ paneRef: { role: "base" }, db, databases: [] });
    await seed.seedPane({ paneRef: { role: "pr" }, db, databases: [] });
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("refuses a pane database that is not a loopback emulator", async () => {
    const seed = createSeed({ snapshot: async () => items(1) });
    await expect(seed.seedPane({ paneRef, db: { ...db, endpoint: "https://dynamodb.us-east-1.amazonaws.com" }, databases: [] }))
      .rejects.toThrow(/loopback/);
    expect(doc.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });
});
