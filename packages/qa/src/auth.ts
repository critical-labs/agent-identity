import { createHash, randomBytes } from "node:crypto";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { AuthBootstrap } from "@critical-labs/qa-conductor";
import { localClient, type PaneDb } from "./dynamodb-local.js";

/** Sign the reviewer in to each pane's fleet dashboard: mint a fresh viewer
 *  key per pane, store its hash in that pane's table (the scheme
 *  AgentsRepo.verifyViewerKey checks, as `mailctl viewer-key create` writes
 *  it), and hand back a landing URL carrying the key in the fragment, which
 *  never reaches a server or proxy log. */
export function createAuth({
  randomKey = () => randomBytes(32).toString("hex"),
  now = () => new Date(),
}: {
  randomKey?: () => string;
  now?: () => Date;
} = {}): AuthBootstrap<PaneDb> & { requiresDb: true } {
  return {
    requiresDb: true,

    async establishSession({ pane, db }) {
      if (!db) throw new Error("the viewer key needs the pane's database");
      const key = randomKey();
      const hash = createHash("sha256").update(key).digest("hex");
      const client = localClient(db);
      try {
        await DynamoDBDocumentClient.from(client).send(new PutCommand({
          TableName: db.tableName,
          Item: { PK: `VIEWER#${hash}`, SK: "VIEWER", label: "qa", createdAt: now().toISOString() },
        }));
      } finally {
        client.destroy();
      }
      const origin = pane.publicOrigin.replace(/\/+$/, "");
      return { landingUrl: `${origin}/ui/?api=${encodeURIComponent(origin)}#key=${key}` };
    },
  };
}
