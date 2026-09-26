import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TABLE_KEYS } from "@agent-identity/shared";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deps } from "./app.js";
import { assertLocalEndpoint, createDevApp, ensureTable } from "./dev-app.js";

function makeDeps(): Deps {
  return {
    agents: { verifyViewerKey: vi.fn(async (k: string) => k === "vk"), getByFingerprint: vi.fn(async () => undefined) } as never,
    emails: {} as never,
    activity: { fleetRoster: vi.fn(async () => []) } as never,
    nonces: { recordOnce: async () => true } as never,
    readBody: vi.fn(async () => ({ text: "", links: [] })),
    fleetKeyRequired: true,
    publicRepos: [],
    mailDomain: "mail.localhost",
    autoCapabilities: [],
  };
}

function uiFile(html = "<html><body>fleet</body></html>"): string {
  const path = join(mkdtempSync(join(tmpdir(), "dev-app-")), "index.html");
  writeFileSync(path, html);
  return path;
}

describe("createDevApp", () => {
  it("serves the dashboard at /ui/ with no credentials", async () => {
    const app = createDevApp(makeDeps(), { uiFile: uiFile() });
    const res = await app.request("/ui/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("fleet");
  });

  it("redirects /ui to /ui/", async () => {
    const res = await createDevApp(makeDeps(), { uiFile: uiFile() }).request("/ui");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/ui/");
  });

  it("reads the dashboard file per request (edits show up without a restart)", async () => {
    const file = uiFile("<p>v1</p>");
    const app = createDevApp(makeDeps(), { uiFile: file });
    expect(await (await app.request("/ui/")).text()).toContain("v1");
    writeFileSync(file, "<p>v2</p>");
    expect(await (await app.request("/ui/")).text()).toContain("v2");
  });

  it("keeps the fleet routes viewer-key gated", async () => {
    const app = createDevApp(makeDeps(), { uiFile: uiFile() });
    expect((await app.request("/fleet/agents")).status).toBe(401);
    expect((await app.request("/fleet/agents", { headers: { "x-viewer-key": "nope" } })).status).toBe(403);
    expect((await app.request("/fleet/agents", { headers: { "x-viewer-key": "vk" } })).status).toBe(200);
  });

  it("keeps every other API path signature gated", async () => {
    const res = await createDevApp(makeDeps(), { uiFile: uiFile() }).request("/emails");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing auth headers" });
  });

  it("adds the CORS headers API Gateway adds in production", async () => {
    const app = createDevApp(makeDeps(), { uiFile: uiFile() });
    const res = await app.request("/fleet/agents", { headers: { origin: "http://elsewhere", "x-viewer-key": "vk" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const pre = await app.request("/fleet/agents", {
      method: "OPTIONS",
      headers: { origin: "http://elsewhere", "access-control-request-method": "GET", "access-control-request-headers": "x-viewer-key" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/x-viewer-key/);
  });
});

describe("ensureTable", () => {
  const ddb = mockClient(DynamoDBClient);
  beforeEach(() => ddb.reset());

  it("creates the table from TABLE_KEYS when it is missing", async () => {
    ddb.on(DescribeTableCommand).rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    ddb.on(CreateTableCommand).resolves({});
    expect(await ensureTable(new DynamoDBClient({}), "tbl")).toBe("created");
    const input = ddb.commandCalls(CreateTableCommand)[0].args[0].input;
    expect(input.TableName).toBe("tbl");
    expect(input.BillingMode).toBe("PAY_PER_REQUEST");
    expect(input.KeySchema).toEqual([
      { AttributeName: TABLE_KEYS.partitionKey, KeyType: "HASH" },
      { AttributeName: TABLE_KEYS.sortKey, KeyType: "RANGE" },
    ]);
  });

  it("leaves an existing table alone", async () => {
    ddb.on(DescribeTableCommand).resolves({ Table: { TableName: "tbl" } });
    expect(await ensureTable(new DynamoDBClient({}), "tbl")).toBe("exists");
    expect(ddb.commandCalls(CreateTableCommand)).toHaveLength(0);
  });

  it("rethrows anything other than a missing table", async () => {
    ddb.on(DescribeTableCommand).rejects(new Error("AccessDenied"));
    await expect(ensureTable(new DynamoDBClient({}), "tbl")).rejects.toThrow(/AccessDenied/);
  });
});

describe("assertLocalEndpoint", () => {
  it("refuses to run without a local DynamoDB endpoint", () => {
    expect(() => assertLocalEndpoint({})).toThrow(/AWS_ENDPOINT_URL_DYNAMODB/);
  });

  it("accepts the service-specific or the global endpoint variable", () => {
    expect(assertLocalEndpoint({ AWS_ENDPOINT_URL_DYNAMODB: "http://127.0.0.1:8000" })).toBe("http://127.0.0.1:8000");
    expect(assertLocalEndpoint({ AWS_ENDPOINT_URL: "http://127.0.0.1:9000" })).toBe("http://127.0.0.1:9000");
  });
});
