import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentsRepo } from "./agents.js";

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new AgentsRepo(ddb as never, "tbl", "mail.example.com");

beforeEach(() => ddb.reset());

describe("AgentsRepo.register", () => {
  it("returns existing identity when fingerprint already registered", async () => {
    ddb.on(GetCommand).resolves({
      Item: { agentId: "482913", address: "482913@mail.example.com", status: "active" },
    });
    const res = await repo.register("PUBKEY", "fp1");
    expect(res).toEqual({ agentId: "482913", address: "482913@mail.example.com" });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("creates agent + addr mirror transactionally when new", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    const res = await repo.register("PUBKEY", "fp1");
    expect(res.agentId).toMatch(/^\d{6}$/);
    expect(res.address).toBe(`${res.agentId}@mail.example.com`);
    const tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(tx.TransactItems).toHaveLength(2);
  });

  it("retries with a new numeric id on address collision", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand)
      .rejectsOnce(Object.assign(new Error("x"), { name: "TransactionCanceledException" }))
      .resolves({});
    const res = await repo.register("PUBKEY", "fp1");
    expect(res.agentId).toMatch(/^\d{6}$/);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });
});

describe("AgentsRepo lookups", () => {
  it("getByLocalPart resolves mirror then agent", async () => {
    ddb.on(GetCommand, { TableName: "tbl", Key: { PK: "ADDR#482913", SK: "ADDR" } })
      .resolves({ Item: { fingerprint: "fp1" } });
    ddb.on(GetCommand, { TableName: "tbl", Key: { PK: "AGENT#fp1", SK: "AGENT" } })
      .resolves({ Item: { agentId: "482913", status: "active" } });
    const agent = await repo.getByLocalPart("482913");
    expect(agent?.agentId).toBe("482913");
  });

  it("verifyFleetKey hashes and checks existence", async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: "FLEET#abc" } });
    expect(await repo.verifyFleetKey("secret")).toBe(true);
    ddb.on(GetCommand).resolves({});
    expect(await repo.verifyFleetKey("secret")).toBe(false);
  });

  it("revoke sets status=revoked", async () => {
    ddb.on(UpdateCommand).resolves({});
    await repo.revoke("fp1");
    const call = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(call.Key).toEqual({ PK: "AGENT#fp1", SK: "AGENT" });
  });
});
