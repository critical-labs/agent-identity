import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_TEXT } from "./redact.js";
import {
  createSnapshotLoader, deriveMailDomain, describeSnapshot, findTableName, loadSnapshot, memoize, type Snapshot,
} from "./snapshot.js";

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
    expect(await loadSnapshot({ stackName: "AgentIdentity", cfn, ddb })).toEqual({
      items: [], dropped: {}, droppedAttributes: {}, mailDomain: null, mailDomainCounts: { matching: 0, addresses: 0 },
    });
  });

  it("derives the fleet mail domain from the kept agents' addresses, across pages", async () => {
    docMock.on(ScanCommand)
      .resolvesOnce({ Items: [{ ...agent, address: "a@mail.example.test" }, email], LastEvaluatedKey: { PK: "x", SK: "y" } })
      .resolvesOnce({ Items: [
        { PK: "AGENT#fp2", SK: "AGENT", agentId: "731904", address: "b@mail.example.test" },
        { PK: "AGENT#fp3", SK: "AGENT", agentId: "731905", address: "c@mail.example.test" },
        // Dropped whole, so its other domain doesn't count.
        { PK: "AGENT#fp4", SK: "SESSION#1", address: "d@other.example.test" },
      ] });
    const snapshot = await loadSnapshot({ stackName: "AgentIdentity", cfn, ddb });
    expect(snapshot.mailDomain).toBe("mail.example.test");
    expect(snapshot.mailDomainCounts).toEqual({ matching: 3, addresses: 3 });
  });

  it("derives nothing when the kept agents' addresses span pages and domains", async () => {
    docMock.on(ScanCommand)
      .resolvesOnce({ Items: [{ ...agent, address: "a@mail.example.test" }], LastEvaluatedKey: { PK: "x", SK: "y" } })
      .resolvesOnce({ Items: [{ PK: "AGENT#fp2", SK: "AGENT", agentId: "731904", address: "b@other.example.test" }] });
    const snapshot = await loadSnapshot({ stackName: "AgentIdentity", cfn, ddb });
    expect(snapshot.mailDomain).toBeNull();
    expect(snapshot.mailDomainCounts).toEqual({ matching: 0, addresses: 2 });
  });
});

describe("deriveMailDomain", () => {
  const agents = (...addresses: unknown[]) =>
    addresses.map((address, i) => ({ PK: `AGENT#fp${i}`, SK: "AGENT", agentId: String(100000 + i), address }));
  const none = { mailDomain: null, mailDomainCounts: { matching: 0, addresses: 0 } };

  it("takes the one domain all the agents' addresses are at", () => {
    expect(deriveMailDomain(agents("a@mail.example.test", "b@mail.example.test", "c@mail.example.test")))
      .toEqual({ mailDomain: "mail.example.test", mailDomainCounts: { matching: 3, addresses: 3 } });
  });

  it("takes a lone agent's domain", () => {
    expect(deriveMailDomain(agents("a@mail.example.test")))
      .toEqual({ mailDomain: "mail.example.test", mailDomainCounts: { matching: 1, addresses: 1 } });
  });

  it("derives nothing from a majority: it need not be prod's domain", () => {
    // Prod's MAIL_DOMAIN moved to new.example.test; older agents keep their
    // old addresses. The majority's domain would leave the new ones unredacted.
    const items = agents("a@old.example.test", "b@old.example.test", "c@old.example.test", "d@new.example.test");
    expect(deriveMailDomain(items)).toEqual({ mailDomain: null, mailDomainCounts: { matching: 0, addresses: 4 } });
    // One mailbox made at another domain is enough.
    const many = agents(...Array.from({ length: 20 }, (_, i) => `a${i}@mail.example.test`), "z@other.example.test");
    expect(deriveMailDomain(many)).toEqual({ mailDomain: null, mailDomainCounts: { matching: 0, addresses: 21 } });
  });

  it("derives nothing from a plurality or a tie", () => {
    const items = agents(
      "a@mail.example.test", "b@mail.example.test", "c@mail.example.test",
      "d@one.example.test", "e@one.example.test", "f@two.example.test", "g@two.example.test",
    );
    expect(deriveMailDomain(items)).toEqual({ mailDomain: null, mailDomainCounts: { matching: 0, addresses: 7 } });
    expect(deriveMailDomain(agents("a@mail.example.test", "b@mail.example.test", "c@other.example.test", "d@other.example.test")))
      .toEqual({ mailDomain: null, mailDomainCounts: { matching: 0, addresses: 4 } });
  });

  it("derives nothing when no agent has an address", () => {
    expect(deriveMailDomain([])).toEqual(none);
    expect(deriveMailDomain([{ PK: "AGENT#fp1", SK: "AGENT", agentId: "482913" }])).toEqual(none);
  });

  it("leaves invalid addresses out, of the count too", () => {
    const items = agents(
      "a@mail.example.test", "b@mail.example.test",
      "no-at-sign", "c@", "@other.example.test", "d@localhost", "e@https://other.example.test", "f@other.example.test:25",
      "g@other.example.test/inbox", "h@other example.test", "i@other..example.test", "j@-other.example.test",
      "k@K.example.test", "l@other.examplе.test", "", 42, null, ["m@other.example.test"], { domain: "other.example.test" },
    );
    expect(deriveMailDomain(items)).toEqual({ mailDomain: "mail.example.test", mailDomainCounts: { matching: 2, addresses: 2 } });
    expect(deriveMailDomain(agents("no-at-sign", "d@localhost", 42))).toEqual(none);
  });

  it("takes the text after the last @, lower-cased", () => {
    expect(deriveMailDomain(agents("\"a@b\"@Mail.Example.TEST", "B@MAIL.EXAMPLE.TEST", "c@mail.example.test")))
      .toEqual({ mailDomain: "mail.example.test", mailDomainCounts: { matching: 3, addresses: 3 } });
  });

  it("counts agent records only", () => {
    const other = "x@other.example.test";
    const items = [
      ...agents("a@mail.example.test"),
      { PK: "ADDR#482913", SK: "ADDR", fingerprint: "fp1", address: other },
      { PK: "AGENT#fp1", SK: "STATUS", state: "idle", address: other },
      { PK: "AGENT#fp1", SK: "ACT#01J9", type: "forge_pr", address: other },
      { PK: "MAILBOX#482913", SK: "EMAIL#01J9", from: other, address: other },
      { PK: "MAILBOX#482913", SK: "EMAIL#01JA", from: other, address: other },
    ];
    expect(deriveMailDomain(items)).toEqual({ mailDomain: "mail.example.test", mailDomainCounts: { matching: 1, addresses: 1 } });
  });
});

describe("describeSnapshot", () => {
  const items = [{ PK: "AGENT#a" }, { PK: "AGENT#b" }];
  const base: Snapshot = { items, dropped: {}, droppedAttributes: {}, mailDomain: null, mailDomainCounts: { matching: 0, addresses: 0 } };
  const derived: Snapshot = { ...base, mailDomain: "mail.example.test", mailDomainCounts: { matching: 4, addresses: 4 } };

  /** A snapshot of agents at these addresses, with the domain they derive. */
  const fleet = (...addresses: string[]): Snapshot => {
    const agents = addresses.map((address, i) => ({ PK: `AGENT#fp${i}`, SK: "AGENT", agentId: String(100000 + i), address }));
    return { items: agents, dropped: {}, droppedAttributes: {}, ...deriveMailDomain(agents) };
  };
  const at = (domain: string, n: number) => Array.from({ length: n }, (_, i) => `a${i}@${domain}`);

  it("says how much was kept, and what was dropped per shape, sorted", () => {
    expect(describeSnapshot({ ...derived, dropped: { "NONCE#/SIG#": 2, "FLEET#/FLEET": 1 } })).toBe(
      "snapshot: kept 2 item(s), dropped 3: FLEET#/FLEET ×1, NONCE#/SIG# ×2; mail domain: derived from 4 of 4 agent address(es)",
    );
  });

  it("names the unlisted attributes it dropped from kept items, sorted", () => {
    const droppedAttributes = { "AGENT#/STATUS .sessionToken": 1, "AGENT#/AGENT .webhookSecret": 3 };
    expect(describeSnapshot({ ...derived, droppedAttributes })).toBe(
      "snapshot: kept 2 item(s), dropped none; unlisted attributes dropped 4: AGENT#/AGENT .webhookSecret ×3, AGENT#/STATUS .sessionToken ×1" +
        "; mail domain: derived from 4 of 4 agent address(es)",
    );
  });

  it("says when nothing was dropped", () => {
    expect(describeSnapshot({ ...base, items: [] })).toBe(
      "snapshot: kept 0 item(s), dropped none; mail domain: not derivable (no agent has a valid address)",
    );
  });

  it("says why the mail domain isn't derivable, by counts only", () => {
    expect(describeSnapshot({ ...base, mailDomainCounts: { matching: 0, addresses: 4 } })).toBe(
      "snapshot: kept 2 item(s), dropped none; mail domain: not derivable (the 4 agent address(es) are not all at one domain)",
    );
  });

  it("says how a QA_MAIL_DOMAIN override compares with the agents' addresses", () => {
    expect(describeSnapshot(fleet(...at("mail.example.test", 3)), { mailDomainOverride: "mail.example.test" }))
      .toBe("snapshot: kept 3 item(s), dropped none; mail domain: set by QA_MAIL_DOMAIN (matches 3 of 3 agent address(es))");
    // A fleet across domains, which can't derive one, with the override at most of it.
    expect(describeSnapshot(
      fleet(...at("new.example.test", 2), ...at("old.example.test", 1)),
      { mailDomainOverride: "new.example.test" },
    )).toBe("snapshot: kept 3 item(s), dropped none; mail domain: set by QA_MAIL_DOMAIN (matches 2 of 3 agent address(es))");
    expect(describeSnapshot(base, { mailDomainOverride: "mail.example.test" })).toBe(
      "snapshot: kept 2 item(s), dropped none; mail domain: set by QA_MAIL_DOMAIN (no agent has a valid address to check it against)",
    );
  });

  it("warns when a QA_MAIL_DOMAIN override matches no agent address", () => {
    // A typo in an older .env.qa, which wins over a clean derivation.
    const snapshot = fleet("a@Mail.Example.test", "b@mail.example.test", "c@MAIL.EXAMPLE.TEST");
    expect(snapshot.mailDomain).toBe("mail.example.test");
    expect(describeSnapshot(snapshot, { mailDomainOverride: "mail.exmaple.test" })).toBe(
      "snapshot: kept 3 item(s), dropped none; mail domain: set by QA_MAIL_DOMAIN (matches 0 of 3 agent address(es)); " +
        "WARNING: no agent address is at it: check that QA_MAIL_DOMAIN is prod's MAIL_DOMAIN, " +
        "or unset it to use the domain all of them are at",
    );
    // Across domains, there is no derived domain to fall back on.
    expect(describeSnapshot(
      fleet(...at("one.example.test", 2), ...at("two.example.test", 2)),
      { mailDomainOverride: "mail.exmaple.test" },
    )).toBe(
      "snapshot: kept 4 item(s), dropped none; mail domain: set by QA_MAIL_DOMAIN (matches 0 of 4 agent address(es)); " +
        "WARNING: no agent address is at it: check that QA_MAIL_DOMAIN is prod's MAIL_DOMAIN",
    );
  });

  it("warns when a QA_MAIL_DOMAIN override matches only half of the agent addresses, or fewer", () => {
    for (const [atOverride, elsewhere] of [[2, 2], [1, 3]]) {
      expect(describeSnapshot(
        fleet(...at("new.example.test", atOverride), ...at("old.example.test", elsewhere)),
        { mailDomainOverride: "new.example.test" },
      )).toBe(
        `snapshot: kept 4 item(s), dropped none; mail domain: set by QA_MAIL_DOMAIN (matches ${atOverride} of 4 agent address(es)); ` +
          "WARNING: at most half of the agent addresses are at it: check that QA_MAIL_DOMAIN is prod's MAIL_DOMAIN",
      );
    }
  });

  it("never names the mail domain, derived or overridden: logs may be pasted publicly", () => {
    const snapshot = fleet(...at("mail.example.test", 3));
    for (const mailDomainOverride of [undefined, "mail.example.test", "mail.exmaple.test", "other.example.test"]) {
      expect(describeSnapshot(derived, { mailDomainOverride })).not.toMatch(/example|exmaple|\.test/);
      expect(describeSnapshot(snapshot, { mailDomainOverride })).not.toMatch(/example|exmaple|\.test/);
    }
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
    const first = await snapshot();
    expect(first.items).toEqual([agent()]);
    expect(await snapshot()).toBe(first);
    expect(cfnMock.commandCalls(DescribeStackResourcesCommand)).toHaveLength(1);
    expect(docMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  it("never logs the mail domain it derives, the summary included", async () => {
    const logged: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); }));
    try {
      docMock.on(ScanCommand).resolves({ Items: [
        { ...agent(), address: "a@mail.example.test" },
        { PK: "AGENT#fp2", SK: "AGENT", agentId: "731904", address: "b@mail.example.test" },
      ] });
      // As serve.ts logs it.
      const snapshot = createSnapshotLoader({
        stackName: "AgentIdentity",
        onLoaded: (loaded) => console.log(`[qa] ${describeSnapshot(loaded)}`),
      });
      expect((await snapshot()).mailDomain).toBe("mail.example.test");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged).toEqual([["[qa] snapshot: kept 2 item(s), dropped none; mail domain: derived from 2 of 2 agent address(es)"]]);
    expect(JSON.stringify(logged)).not.toMatch(/example|\.test/);
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
    const loaded = await snapshot();
    expect(onLoaded).toHaveBeenCalledOnce();
    expect(onLoaded).toHaveBeenCalledWith({
      items: [agent()], dropped: { "VIEWER#/VIEWER": 1 }, droppedAttributes: {},
      mailDomain: null, mailDomainCounts: { matching: 0, addresses: 0 },
    });
    expect(onLoaded.mock.calls[0][0]).toBe(loaded);
  });

  function agent() {
    return { PK: "AGENT#fp1", SK: "AGENT", agentId: "482913" };
  }
});
