// The QA panes' data: one read-only Scan of the real table, redacted item by
// item, held only in this process's memory. The clients use the default
// credential chain, i.e. the reviewer's own AWS profile; those credentials
// never leave the harness process (panes get dummy ones).
import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { redactItem, type Item } from "./redact.js";

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

/** Scan the whole table (read-only) and keep what redactItem allows. Items
 *  are redacted page by page, so unredacted mail never accumulates. */
export async function loadSnapshot({ stackName, cfn, ddb }: {
  stackName: string;
  cfn: CloudFormationClient;
  ddb: DynamoDBDocumentClient;
}): Promise<Item[]> {
  const TableName = await findTableName(cfn, stackName);
  const out: Item[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ TableName, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }));
    for (const item of page.Items ?? []) {
      const kept = redactItem(item);
      if (kept) out.push(kept);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
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
 *  every pane until the conductor restarts. */
export function createSnapshotLoader({ stackName }: { stackName: string }): () => Promise<Item[]> {
  return memoize(async () => {
    const cfn = new CloudFormationClient({});
    const client = new DynamoDBClient({});
    try {
      return await loadSnapshot({ stackName, cfn, ddb: DynamoDBDocumentClient.from(client) });
    } finally {
      cfn.destroy();
      client.destroy();
    }
  });
}
