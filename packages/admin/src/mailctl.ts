#!/usr/bin/env -S npx tsx
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Command } from "commander";
import { createFleetKey, listAgents, revokeAgent, tagAgent, untagAgent } from "./commands.js";

const table = process.env.AGENT_IDENTITY_TABLE;
if (!table) {
  console.error("Set AGENT_IDENTITY_TABLE (DynamoDB table name)");
  process.exit(1);
}
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const program = new Command("mailctl");

program.command("fleet-key")
  .command("create")
  .option("--label <label>", "label for this key", "default")
  .action(async (opts: { label: string }) => {
    const key = await createFleetKey(ddb, table, opts.label);
    console.log("Fleet key (shown once, store it now):");
    console.log(key);
  });

const agent = program.command("agent");
agent.command("list").action(async () => {
  console.table(await listAgents(ddb, table));
});
agent.command("revoke <agentId>").action(async (agentId: string) => {
  await revokeAgent(ddb, table, agentId);
  console.log(`revoked ${agentId}`);
});
agent.command("tag <agentId> <capability>").action(async (agentId: string, capability: string) => {
  await tagAgent(ddb, table, agentId, capability);
  console.log(`tagged ${agentId} +${capability}`);
});
agent.command("untag <agentId> <capability>").action(async (agentId: string, capability: string) => {
  await untagAgent(ddb, table, agentId, capability);
  console.log(`untagged ${agentId} -${capability}`);
});

await program.parseAsync();
