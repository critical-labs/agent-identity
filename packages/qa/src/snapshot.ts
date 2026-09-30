// The QA panes' data: one read-only Scan of the real table, redacted item by
// item, held only in this process's memory. The clients use the default
// credential chain, i.e. the reviewer's own AWS profile, and QA_AWS_REGION
// when set; those credentials never leave the harness process (panes get
// dummy ones).
import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { isMailDomain, lowerAscii } from "./config.js";
import { redactItem, shapeKey, shapeOf, unlistedAttributes, type Item } from "./redact.js";

/** The physical name of the stack's table (CDK logical id `Table<hash>`). */
export async function findTableName(cfn: CloudFormationClient, stackName: string): Promise<string> {
  const { StackResources = [] } = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  const tables = StackResources.filter((r) =>
    r.ResourceType === "AWS::DynamoDB::Table" && r.LogicalResourceId?.startsWith("Table") && r.PhysicalResourceId);
  if (tables.length !== 1) {
    throw new Error(tables.length === 0
      ? `stack ${stackName} has no DynamoDB table with a logical id starting "Table"`
      : `stack ${stackName} has ${tables.length} DynamoDB tables with a logical id starting "Table"; expected one`);
  }
  return tables[0].PhysicalResourceId!;
}

/** The redacted items, plus the drop report: how many items were dropped
 *  per shape (`NONCE#/SIG#` → 12; see shapeKey), and how often a kept item
 *  lost an attribute its shape doesn't list (`AGENT#/AGENT .webhookSecret`
 *  → 3; see unlistedAttributes). Key prefixes and attribute names only,
 *  never values. */
export interface Snapshot {
  items: Item[];
  dropped: Record<string, number>;
  droppedAttributes: Record<string, number>;
  /** The fleet's mail domain, derived from the agents' addresses (see
   *  deriveMailDomain), or null. It feeds the panes' MAIL_DOMAIN and is
   *  never logged: logs may be pasted publicly. */
  mailDomain: string | null;
  /** The derivation's counts, which the summary prints instead: agents with
   *  a valid address, and how many of them are at mailDomain (all of them,
   *  or 0 when null). */
  mailDomainCounts: { matching: number; addresses: number };
}

const byKey = ([a]: [string, number], [b]: [string, number]) => (a < b ? -1 : a > b ? 1 : 0);

/** The domain of an agent's address: the text after its last `@`,
 *  lower-cased (ASCII only, see lowerAscii), when that is a bare mail domain
 *  (see isMailDomain) after a non-empty local part; otherwise null. */
function addressDomain(address: unknown): string | null {
  if (typeof address !== "string") return null;
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = lowerAscii(address.slice(at + 1));
  return isMailDomain(domain) ? domain : null;
}

/** The domains of the agent records' (`AGENT#…` + `AGENT`) valid addresses,
 *  one per such agent. Invalid addresses, and other records, are left out. */
function agentDomains(items: Item[]): string[] {
  const domains: string[] = [];
  for (const item of items) {
    if (shapeOf(item) !== "agent") continue;
    const domain = addressDomain(item.address);
    if (domain !== null) domains.push(domain);
  }
  return domains;
}

/** The fleet's mail domain, from the addresses of the agent records: the
 *  one domain every agent with a valid address is at. Invalid addresses
 *  don't count at all.
 *
 *  It fails closed: with no valid address, or addresses at more than one
 *  domain, it is null, and the reviewer sets QA_MAIL_DOMAIN instead. A
 *  majority isn't enough, since the most common domain need not be prod's
 *  MAIL_DOMAIN (after MAIL_DOMAIN changed, older agents keep their old
 *  addresses; an operator can create a mailbox at another domain), and a
 *  wrong domain would leave fleet addresses unredacted in the panes. */
export function deriveMailDomain(items: Item[]): Pick<Snapshot, "mailDomain" | "mailDomainCounts"> {
  const domains = agentDomains(items);
  const [first] = domains;
  if (first !== undefined && domains.every((domain) => domain === first)) {
    return { mailDomain: first, mailDomainCounts: { matching: domains.length, addresses: domains.length } };
  }
  return { mailDomain: null, mailDomainCounts: { matching: 0, addresses: domains.length } };
}

/** Whether and from how many addresses the mail domain was derived:
 *  counts only, never the domain. */
export function describeMailDomain({ mailDomain, mailDomainCounts: { matching, addresses } }: Pick<
  Snapshot, "mailDomain" | "mailDomainCounts"
>): string {
  if (mailDomain !== null) return `derived from ${matching} of ${addresses} agent address(es)`;
  return addresses === 0
    ? "not derivable (no agent has a valid address)"
    : `not derivable (the ${addresses} agent address(es) are not all at one domain)`;
}

/** How the QA_MAIL_DOMAIN override compares with the agents' addresses, by
 *  counts only, never the domain. A stale or mistyped override (an older
 *  `.env.qa` required the key) wins over the derivation, and would give the
 *  panes a fleet mail redaction unlike prod's, so the line warns when at
 *  most half of the addresses are at it. In a fleet whose addresses span
 *  several domains that can be right, hence "check", not an error. */
function describeOverride(items: Item[], override: string, derived: boolean): string {
  const domains = agentDomains(items);
  const addresses = domains.length;
  if (addresses === 0) return "set by QA_MAIL_DOMAIN (no agent has a valid address to check it against)";
  const matching = domains.filter((domain) => domain === override).length;
  const line = `set by QA_MAIL_DOMAIN (matches ${matching} of ${addresses} agent address(es))`;
  if (matching * 2 > addresses) return line;
  const why = matching === 0 ? "no agent address is at it" : "at most half of the agent addresses are at it";
  const fix = derived ? ", or unset it to use the domain all of them are at" : "";
  return `${line}; WARNING: ${why}: check that QA_MAIL_DOMAIN is prod's MAIL_DOMAIN${fix}`;
}

/** Scan the whole table (read-only) and keep what redactItem allows. Items
 *  are redacted page by page, so unredacted mail never accumulates. The
 *  mail domain is derived from the kept agent records. */
export async function loadSnapshot({ stackName, cfn, ddb }: {
  stackName: string;
  cfn: CloudFormationClient;
  ddb: DynamoDBDocumentClient;
}): Promise<Snapshot> {
  const TableName = await findTableName(cfn, stackName);
  const items: Item[] = [];
  const dropped = new Map<string, number>();
  const droppedAttributes = new Map<string, number>();
  const count = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ TableName, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }));
    for (const item of page.Items ?? []) {
      const kept = redactItem(item);
      if (kept) {
        items.push(kept);
        for (const name of unlistedAttributes(item)) count(droppedAttributes, `${shapeKey(item)} .${name}`);
      } else {
        count(dropped, shapeKey(item));
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const sorted = (counts: Map<string, number>) => Object.fromEntries([...counts].sort(byKey));
  return { items, dropped: sorted(dropped), droppedAttributes: sorted(droppedAttributes), ...deriveMailDomain(items) };
}

/** `3: A ×1, B ×2`, or `none`. */
function describeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(byKey);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return total === 0 ? "none" : `${total}: ${entries.map(([key, n]) => `${key} ×${n}`).join(", ")}`;
}

/** One log line: what the panes get, and what they don't, per shape and per
 *  unlisted attribute. A new kind of item or attribute showing up here is
 *  the cue to decide, in redact.ts, whether panes should see it. It ends
 *  with where the panes' mail domain comes from (`mailDomainOverride`:
 *  QA_MAIL_DOMAIN, when set) and how it compares with the agents'
 *  addresses, by counts only: the domain itself is never logged. */
export function describeSnapshot(snapshot: Snapshot, { mailDomainOverride }: { mailDomainOverride?: string } = {}): string {
  const { items, dropped, droppedAttributes } = snapshot;
  const parts = [`snapshot: kept ${items.length} item(s), dropped ${describeCounts(dropped)}`];
  if (Object.keys(droppedAttributes).length > 0) parts.push(`unlisted attributes dropped ${describeCounts(droppedAttributes)}`);
  parts.push(`mail domain: ${mailDomainOverride === undefined
    ? describeMailDomain(snapshot)
    : describeOverride(items, mailDomainOverride, snapshot.mailDomain !== null)}`);
  return parts.join("; ");
}

/** Run `load` once and share its result. A failure isn't cached, so a later
 *  pane (or session) can retry, e.g. after the reviewer refreshes their
 *  AWS session. */
export function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

/** The shared snapshot, for the seed's items and the base env's mail
 *  domain: scanned on the first call (normally the first pane's seed), then
 *  reused by every pane until the conductor restarts. `onLoaded` sees each
 *  snapshot, with its drop report, once.
 *
 *  `region` (QA_AWS_REGION) is the prod stack's region, for both clients.
 *  Without it the default chain decides, which may not be the region the
 *  deploy workflow uses. */
export function createSnapshotLoader({ stackName, region, onLoaded }: {
  stackName: string;
  region?: string;
  onLoaded?: (snapshot: Snapshot) => void;
}): () => Promise<Snapshot> {
  return memoize(async () => {
    const config = region ? { region } : {};
    const cfn = new CloudFormationClient(config);
    const client = new DynamoDBClient(config);
    try {
      const snapshot = await loadSnapshot({ stackName, cfn, ddb: DynamoDBDocumentClient.from(client) });
      onLoaded?.(snapshot);
      return snapshot;
    } finally {
      cfn.destroy();
      client.destroy();
    }
  });
}
