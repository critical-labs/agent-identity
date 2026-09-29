import { ensureTable } from "@agent-identity/api";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Seed } from "@critical-labs/qa-conductor";
import { QA_TABLE, localClient, type PaneDb } from "./dynamodb-local.js";
import type { Item } from "./redact.js";

/** BatchWriteItem's limit. */
const BATCH = 25;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fill each pane's fresh emulator with the (already redacted) snapshot.
 *  `snapshot` is the shared, memoized loader: the first pane's seed triggers
 *  the prod Scan, and every later pane reuses its result. */
export function createSeed({
  snapshot,
  sleepFn = defaultSleep,
  maxAttempts = 8,
}: {
  snapshot: () => Promise<Item[]>;
  sleepFn?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}): Seed<PaneDb> {
  return {
    databases: [QA_TABLE],

    async seedPane({ db }) {
      const client = localClient(db);
      try {
        await ensureTable(client, db.tableName);
        const items = await snapshot();
        const doc = DynamoDBDocumentClient.from(client);
        for (let i = 0; i < items.length; i += BATCH) {
          await writeBatch(doc, db.tableName, items.slice(i, i + BATCH), { sleepFn, maxAttempts });
        }
      } finally {
        client.destroy();
      }
    },
  };
}

/** One BatchWriteItem call, re-sending whatever comes back unprocessed with
 *  exponential backoff, and failing after `maxAttempts` calls. */
async function writeBatch(
  doc: DynamoDBDocumentClient,
  table: string,
  items: Item[],
  { sleepFn, maxAttempts }: { sleepFn: (ms: number) => Promise<void>; maxAttempts: number },
): Promise<void> {
  let pending = items.map((Item) => ({ PutRequest: { Item } }));
  for (let attempt = 1; ; attempt++) {
    const res = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
    const unprocessed = res.UnprocessedItems?.[table] ?? [];
    if (unprocessed.length === 0) return;
    if (attempt >= maxAttempts) {
      throw new Error(`seeding ${table}: ${unprocessed.length} item(s) still unprocessed after ${maxAttempts} attempts`);
    }
    pending = unprocessed as typeof pending;
    await sleepFn(Math.min(50 * 2 ** (attempt - 1), 2000));
  }
}
