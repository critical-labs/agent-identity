// The QA panes' data: one read-only Scan of the real table, redacted item by
// item, held only in this process's memory. The clients use the default
// credential chain, i.e. the reviewer's own AWS profile, and QA_AWS_REGION
// when set; those credentials never leave the harness process (panes get
// dummy ones).
import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { redactItem, shapeKey, unlistedAttributes, type Item } from "./redact.js";

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
}

const byKey = ([a]: [string, number], [b]: [string, number]) => (a < b ? -1 : a > b ? 1 : 0);

/** Scan the whole table (read-only) and keep what redactItem allows. Items
 *  are redacted page by page, so unredacted mail never accumulates. */
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
  return { items, dropped: sorted(dropped), droppedAttributes: sorted(droppedAttributes) };
}

/** `3: A ×1, B ×2`, or `none`. */
function describeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(byKey);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return total === 0 ? "none" : `${total}: ${entries.map(([key, n]) => `${key} ×${n}`).join(", ")}`;
}

/** One log line: what the panes get, and what they don't, per shape and per
 *  unlisted attribute. A new kind of item or attribute showing up here is
 *  the cue to decide, in redact.ts, whether panes should see it. */
export function describeSnapshot({ items, dropped, droppedAttributes }: Snapshot): string {
  const line = `snapshot: kept ${items.length} item(s), dropped ${describeCounts(dropped)}`;
  return Object.keys(droppedAttributes).length === 0
    ? line
    : `${line}; unlisted attributes dropped ${describeCounts(droppedAttributes)}`;
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

/** The seed's snapshot: scanned on the first pane's seed, then reused by
 *  every pane until the conductor restarts. `onLoaded` sees each snapshot,
 *  with its drop report, once.
 *
 *  `region` (QA_AWS_REGION) is the prod stack's region, for both clients.
 *  Without it the default chain decides, which may not be the region the
 *  deploy workflow uses. */
export function createSnapshotLoader({ stackName, region, onLoaded }: {
  stackName: string;
  region?: string;
  onLoaded?: (snapshot: Snapshot) => void;
}): () => Promise<Item[]> {
  return memoize(async () => {
    const config = region ? { region } : {};
    const cfn = new CloudFormationClient(config);
    const client = new DynamoDBClient(config);
    try {
      const snapshot = await loadSnapshot({ stackName, cfn, ddb: DynamoDBDocumentClient.from(client) });
      onLoaded?.(snapshot);
      return snapshot.items;
    } finally {
      cfn.destroy();
      client.destroy();
    }
  });
}
