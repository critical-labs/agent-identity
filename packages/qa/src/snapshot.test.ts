import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_TEXT } from "./redact.js";
import { createSnapshotLoader, describeSnapshot, findTableName, loadSnapshot, memoize } from "./snapshot.js";

const cfnMock = mockClient(CloudFormationClient);
const docMock = mockClient(DynamoDBDocumentClient);
const cfn = new CloudFormationClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const resources = [
  { LogicalResourceId: "Mail5E8B1F2A", ResourceType: "AWS::S3::Bucket", PhysicalResourceId: "mail-bucket" },
  { LogicalResourceId: "TableCD117FE6", ResourceType: "AWS::DynamoDB::Table", PhysicalResourceId: "AgentIdentity-TableCD117FE6-ABC123" },
  { LogicalResourceId: "TableReaderRole", ResourceType: "AWS::IAM::Role", PhysicalResourceId: "role" },
];

beforeEach(() => {
  cfnMock.reset();
  docMock.reset();
  cfnMock.on(DescribeStackResourcesCommand).resolves({ StackResources: resources as never });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("findTableName", () => {
  it("resolves the stack's table to its physical name", async () => {
    expect(await findTableName(cfn, "AgentIdentity")).toBe("AgentIdentity-TableCD117FE6-ABC123");
    expect(cfnMock.commandCalls(DescribeStackResourcesCommand)[0].args[0].input).toEqual({ StackName: "AgentIdentity" });
  });

  it("refuses a stack without exactly one table", async () => {
    cfnMock.on(DescribeStackResourcesCommand).resolves({ StackResources: [resources[0]] as never });
    await expect(findTableName(cfn, "AgentIdentity")).rejects.toThrow(/no DynamoDB table/);
    cfnMock.on(DescribeStackResourcesCommand).resolves({
      StackResources: [resources[1], { ...resources[1], LogicalResourceId: "TableOther", PhysicalResourceId: "t2" }] as never,
    });
    await expect(findTableName(cfn, "AgentIdentity")).rejects.toThrow(/2 DynamoDB tables/);
  });
});

describe("loadSnapshot", () => {
  const agent = { PK: "AGENT#fp1", SK: "AGENT", agentId: "482913" };
  const viewer = { PK: "VIEWER#abc", SK: "VIEWER" };
  const email = { PK: "MAILBOX#482913", SK: "EMAIL#01J9", subject: "Code 123456", text: "code 123456", links: ["https://x.test"] };

  it("scans every page of the table, read-only, and redacts as it goes", async () => {
    docMock.on(ScanCommand)
      .resolvesOnce({ Items: [agent, viewer], LastEvaluatedKey: { PK: "VIEWER#abc", SK: "VIEWER" } })
      .resolvesOnce({ Items: [email] });
    const { items, dropped } = await loadSnapshot({ stackName: "AgentIdentity", cfn, ddb });

    const scans = docMock.commandCalls(ScanCommand).map((c) => c.args[0].input);
    expect(scans).toEqual([
      { TableName: "AgentIdentity-TableCD117FE6-ABC123" },
      { TableName: "AgentIdentity-TableCD117FE6-ABC123", ExclusiveStartKey: { PK: "VIEWER#abc", SK: "VIEWER" } },
    ]);
    // Scan is the only call made against the prod table.
    expect(docMock.calls().every((c) => c.args[0] instanceof ScanCommand)).toBe(true);

    expect(items).toEqual([
      agent,
      { PK: "MAILBOX#482913", SK: "EMAIL#01J9", subject: "Code ••••", text: REDACTED_TEXT, links: [] },
    ]);
    expect(dropped).toEqual({ "VIEWER#/VIEWER": 1 });
  });

  it("drops attributes a kept item's shape doesn't list, counting them by name, never by value", async () => {
    docMock.on(ScanCommand).resolvesOnce({ Items: [
      { ...agent, webhookSecret: "s3cr3t-hook" },
      { PK: "AGENT#fp2", SK: "AGENT", agentId: "731904", webhookSecret: "s3cr3t-2", KXQRPT: "x" },
      { PK: "AGENT#482913", SK: "STATUS", state: "idle", sessionToken: "t0k3n" },
      { ...email, html: "<p>code</p>", bodyS3Key: "bodies/abc", headers: { "x-secret": "h" } },
    ] });
    const { items, droppedAttributes } = await loadSnapshot({ stackName: "AgentIdentity", cfn, ddb });
    expect(items[0]).toEqual(agent);
    expect(droppedAttributes).toEqual({
      "AGENT#/AGENT .?": 1,
      "AGENT#/AGENT .webhookSecret": 2,
      "AGENT#/STATUS .sessionToken": 1,
      "MAILBOX#/EMAIL# .headers": 1,
    });
    const report = JSON.stringify(droppedAttributes);
    for (const value of ["s3cr3t", "t0k3n", "KXQRPT", "x-secret", "fp1", "fp2", "482913", "731904"]) expect(report).not.toContain(value);
  });

  it("counts what it drops per PK and SK prefix, never by value", async () => {
    docMock.on(ScanCommand)
      .resolvesOnce({ Items: [agent, { PK: "NONCE#fp1", SK: "SIG#c2lnMQ" }, { PK: "FLEET#9f86d081", SK: "FLEET" }], LastEvaluatedKey: { PK: "x", SK: "y" } })
      .resolvesOnce({ Items: [
        { PK: "NONCE#fp2", SK: "SIG#c2lnMg" },
        { PK: "MAILBOX#482913", SK: "META", note: "n" },
        { PK: "OTP#482913", SK: "731904", code: "731904" },
        // A letter-only code as a whole key looks like a type tag, but isn't a known one.
        { PK: "OTP#482914", SK: "KXQRPT", code: "KXQRPT" },
        { PK: "AGENT#fp1", SK: "SESSION#1", token: "t0k3n" },
      ] });
    const { items, dropped, droppedAttributes } = await loadSnapshot({ stackName: "AgentIdentity", cfn, ddb });
    expect(items).toEqual([agent]);
    expect(droppedAttributes).toEqual({});
    expect(dropped).toEqual({ "AGENT#/SESSION#": 1, "FLEET#/FLEET": 1, "MAILBOX#/?": 1, "NONCE#/SIG#": 2, "OTP#/?": 2 });
    const report = JSON.stringify(dropped);
    for (const value of ["fp1", "fp2", "c2lnMQ", "9f86d081", "482913", "482914", "731904", "KXQRPT", "t0k3n"]) {
      expect(report).not.toContain(value);
    }
  });

  it("handles an empty table", async () => {
    docMock.on(ScanCommand).resolves({});
    expect(await loadSnapshot({ stackName: "AgentIdentity", cfn, ddb })).toEqual({ items: [], dropped: {}, droppedAttributes: {} });
  });
});

describe("describeSnapshot", () => {
  const items = [{ PK: "AGENT#a" }, { PK: "AGENT#b" }];

  it("says how much was kept, and what was dropped per shape, sorted", () => {
    expect(describeSnapshot({ items, dropped: { "NONCE#/SIG#": 2, "FLEET#/FLEET": 1 }, droppedAttributes: {} }))
      .toBe("snapshot: kept 2 item(s), dropped 3: FLEET#/FLEET ×1, NONCE#/SIG# ×2");
  });

  it("names the unlisted attributes it dropped from kept items, sorted", () => {
    const droppedAttributes = { "AGENT#/STATUS .sessionToken": 1, "AGENT#/AGENT .webhookSecret": 3 };
    expect(describeSnapshot({ items, dropped: {}, droppedAttributes })).toBe(
      "snapshot: kept 2 item(s), dropped none; unlisted attributes dropped 4: AGENT#/AGENT .webhookSecret ×3, AGENT#/STATUS .sessionToken ×1",
    );
  });

  it("says when nothing was dropped", () => {
    expect(describeSnapshot({ items: [], dropped: {}, droppedAttributes: {} })).toBe("snapshot: kept 0 item(s), dropped none");
  });
});

describe("memoize", () => {
  it("runs the load once and shares the result", async () => {
    const load = vi.fn(async () => [{ PK: "A" }]);
    const once = memoize(load);
    const [a, b] = await Promise.all([once(), once()]);
    expect(await once()).toBe(a);
    expect(b).toBe(a);
    expect(load).toHaveBeenCalledOnce();
  });

  it("forgets a failed load so the next pane can retry", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("ExpiredToken")).mockResolvedValue([{ PK: "A" }]);
    const once = memoize(load);
    await expect(once()).rejects.toThrow("ExpiredToken");
    expect(await once()).toEqual([{ PK: "A" }]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("createSnapshotLoader", () => {
  it("scans prod once per process, however many panes it seeds", async () => {
    docMock.on(ScanCommand).resolves({ Items: [agent()] });
    const snapshot = createSnapshotLoader({ stackName: "AgentIdentity" });
    expect(await snapshot()).toEqual([agent()]);
    expect(await snapshot()).toEqual([agent()]);
    expect(cfnMock.commandCalls(DescribeStackResourcesCommand)).toHaveLength(1);
    expect(docMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  // The region each client was actually built with: `thisValue` is the
  // client instance whose (mocked) send the call went through.
  async function clientRegions() {
    const [cfnCall] = cfnMock.commandCalls(DescribeStackResourcesCommand);
    const [scanCall] = docMock.commandCalls(ScanCommand);
    return {
      cfn: await (cfnCall.thisValue as CloudFormationClient).config.region(),
      ddb: await (scanCall.thisValue as DynamoDBDocumentClient).config.region(),
    };
  }

  it("uses QA_AWS_REGION for both the CloudFormation and the DynamoDB client", async () => {
    vi.stubEnv("AWS_REGION", "ap-southeast-2");
    docMock.on(ScanCommand).resolves({ Items: [] });
    await createSnapshotLoader({ stackName: "AgentIdentity", region: "eu-west-1" })();
    expect(await clientRegions()).toEqual({ cfn: "eu-west-1", ddb: "eu-west-1" });
  });

  it("otherwise leaves the region to the default chain", async () => {
    vi.stubEnv("AWS_REGION", "ap-southeast-2");
    docMock.on(ScanCommand).resolves({ Items: [] });
    await createSnapshotLoader({ stackName: "AgentIdentity" })();
    expect(await clientRegions()).toEqual({ cfn: "ap-southeast-2", ddb: "ap-southeast-2" });
  });

  it("hands each snapshot, with its drop report, to onLoaded once", async () => {
    docMock.on(ScanCommand)
      .rejectsOnce(new Error("ExpiredToken"))
      .resolves({ Items: [agent(), { PK: "VIEWER#abc", SK: "VIEWER" }] });
    const onLoaded = vi.fn();
    const snapshot = createSnapshotLoader({ stackName: "AgentIdentity", onLoaded });
    await expect(snapshot()).rejects.toThrow("ExpiredToken");
    expect(onLoaded).not.toHaveBeenCalled();
    await snapshot();
    await snapshot();
    expect(onLoaded).toHaveBeenCalledOnce();
    expect(onLoaded).toHaveBeenCalledWith({ items: [agent()], dropped: { "VIEWER#/VIEWER": 1 }, droppedAttributes: {} });
  });

  function agent() {
    return { PK: "AGENT#fp1", SK: "AGENT", agentId: "482913" };
  }
});
