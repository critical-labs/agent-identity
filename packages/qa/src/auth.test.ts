import { AgentsRepo } from "@agent-identity/api";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Pane } from "@critical-labs/qa-conductor";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "./auth.js";
import type { PaneDb } from "./dynamodb-local.js";

// An in-memory table behind the document client: what the auth bootstrap
// puts, the real AgentsRepo gets.
const doc = mockClient(DynamoDBDocumentClient);
let table: Map<string, Record<string, unknown>>;
beforeEach(() => {
  doc.reset();
  table = new Map();
  doc.on(PutCommand).callsFake((input) => {
    table.set(`${input.TableName}|${input.Item.PK}|${input.Item.SK}`, input.Item);
    return {};
  });
  doc.on(GetCommand).callsFake((input) => ({ Item: table.get(`${input.TableName}|${input.Key.PK}|${input.Key.SK}`) }));
});

const db: PaneDb = { endpoint: "http://127.0.0.1:50123", tableName: "agent-identity-qa", region: "us-east-1" };
const pane: Pane<PaneDb> = {
  ref: { role: "base", publicOrigin: "http://127.0.0.1:3101" },
  dsn: db.endpoint,
  db,
  services: { api: { url: "http://127.0.0.1:50124", port: 50124 } },
  publicOrigin: "http://127.0.0.1:3101",
};

const keyOf = (landingUrl: string) => new URLSearchParams(new URL(landingUrl).hash.slice(1)).get("key")!;

describe("createAuth", () => {
  it("needs the pane database", () => {
    expect(createAuth().requiresDb).toBe(true);
  });

  it("mints a viewer key the real AgentsRepo accepts", async () => {
    const { landingUrl } = await createAuth().establishSession({ pane, db });
    const key = keyOf(landingUrl);
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    const repo = new AgentsRepo(DynamoDBDocumentClient.from(new DynamoDBClient({})), db.tableName, "mail.example.test");
    expect(await repo.verifyViewerKey(key)).toBe(true);
    const nearMiss = key.slice(0, -1) + (key.endsWith("0") ? "1" : "0");
    expect(await repo.verifyViewerKey(nearMiss)).toBe(false);
    expect(await repo.verifyViewerKey("not-the-key")).toBe(false);
  });

  it("stores only the key's hash, labelled qa", async () => {
    const now = new Date("2026-09-29T10:00:00.000Z");
    const { landingUrl } = await createAuth({ now: () => now }).establishSession({ pane, db });
    const put = doc.commandCalls(PutCommand)[0].args[0].input;
    expect(put.TableName).toBe("agent-identity-qa");
    expect(put.Item).toEqual({
      PK: expect.stringMatching(/^VIEWER#[0-9a-f]{64}$/), SK: "VIEWER", label: "qa", createdAt: "2026-09-29T10:00:00.000Z",
    });
    expect(JSON.stringify(put)).not.toContain(keyOf(landingUrl));
  });

  it("mints a fresh key per session", async () => {
    const auth = createAuth();
    const a = keyOf((await auth.establishSession({ pane, db })).landingUrl);
    const b = keyOf((await auth.establishSession({ pane, db })).landingUrl);
    expect(a).not.toBe(b);
  });

  it("lands on the pane's dashboard, pointed at the pane, with the key in the fragment", async () => {
    const { landingUrl } = await createAuth({ randomKey: () => "k".repeat(64) }).establishSession({ pane, db });
    expect(landingUrl).toBe(`http://127.0.0.1:3101/ui/?api=${encodeURIComponent("http://127.0.0.1:3101")}#key=${"k".repeat(64)}`);
    const url = new URL(landingUrl);
    expect(url.searchParams.get("api")).toBe("http://127.0.0.1:3101");
    // The harness appends &qa=… to the fragment; the dashboard still reads the key.
    expect(new URLSearchParams(`${url.hash.slice(1)}&qa=${encodeURIComponent("http://127.0.0.1:3100")}`).get("key")).toBe("k".repeat(64));
  });

  it("writes through the pane's own loopback emulator only", async () => {
    await expect(createAuth().establishSession({ pane, db: { ...db, endpoint: "https://dynamodb.us-east-1.amazonaws.com" } }))
      .rejects.toThrow(/loopback/);
    expect(doc.commandCalls(PutCommand)).toHaveLength(0);
  });
});
