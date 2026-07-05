import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createFleetKey, listAgents, revokeAgent } from "./commands.js";

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

describe("mailctl commands", () => {
  it("createFleetKey stores only the sha256 hash and returns the secret once", async () => {
    ddb.on(PutCommand).resolves({});
    const key = await createFleetKey(ddb as never, "tbl", "ci");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe(`FLEET#${createHash("sha256").update(key).digest("hex")}`);
    expect(JSON.stringify(item)).not.toContain(key);
    expect(item.label).toBe("ci");
  });

  it("listAgents scans AGENT records", async () => {
    ddb.on(ScanCommand).resolves({
      Items: [{ PK: "AGENT#fp1", agentId: "482913", address: "482913@d", status: "active" }],
    });
    const agents = await listAgents(ddb as never, "tbl");
    expect(agents).toEqual([
      { fingerprint: "fp1", agentId: "482913", address: "482913@d", status: "active" },
    ]);
  });

  it("revokeAgent resolves agentId via ADDR mirror and sets revoked", async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: "ADDR#482913", SK: "ADDR", fingerprint: "fp1" } });
    ddb.on(UpdateCommand).resolves({});
    await revokeAgent(ddb as never, "tbl", "482913");
    const get = ddb.commandCalls(GetCommand)[0].args[0].input;
    expect(get.Key).toEqual({ PK: "ADDR#482913", SK: "ADDR" });
    const upd = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.Key).toEqual({ PK: "AGENT#fp1", SK: "AGENT" });
  });

  it("revokeAgent throws on unknown agentId", async () => {
    ddb.on(GetCommand).resolves({});
    await expect(revokeAgent(ddb as never, "tbl", "000000")).rejects.toThrow(/no agent/);
  });
});
