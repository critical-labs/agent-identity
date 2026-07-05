import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailsRepo, InvalidCursorError } from "./emails.js";

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new EmailsRepo(ddb as never, "tbl", 90);

beforeEach(() => ddb.reset());

describe("EmailsRepo", () => {
  it("putEmail writes MAILBOX partition with 90-day TTL", async () => {
    ddb.on(PutCommand).resolves({});
    const id = await repo.putEmail("482913", {
      from: "noreply@github.com", subject: "Verify",
      receivedAt: "2026-07-04T10:00:00.000Z",
      text: "hi", links: ["https://github.com/v"], rawS3Key: "raw/m1",
    });
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe("MAILBOX#482913");
    expect(item.SK).toBe(`EMAIL#${id}`);
    const ttlDelta = (item.expiresAt as number) - Date.parse("2026-07-04T10:00:00Z") / 1000;
    expect(ttlDelta).toBe(90 * 24 * 3600);
  });

  it("listEmails queries newest-first and maps summaries", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [{ SK: "EMAIL#01ABC", from: "a@b.c", subject: "s", receivedAt: "t" }],
    });
    const { emails } = await repo.listEmails("482913", {});
    expect(emails).toEqual([{ id: "01ABC", from: "a@b.c", subject: "s", receivedAt: "t" }]);
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ScanIndexForward).toBe(false);
  });

  it("listEmails applies since as SK lower bound", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await repo.listEmails("482913", { since: "2026-07-04T00:00:00Z" });
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.KeyConditionExpression).toContain(":sk");
  });

  it("listEmails rejects a malformed cursor with InvalidCursorError", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await expect(repo.listEmails("482913", { cursor: "notacursor" }))
      .rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("getEmail returns undefined for another agent's email", async () => {
    ddb.on(GetCommand).resolves({});
    expect(await repo.getEmail("482913", "01ABC")).toBeUndefined();
  });
});
