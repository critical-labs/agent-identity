// `pnpm qa:setup`: install DynamoDB Local once (checksum-pinned), then check
// Java and the firewall rule `pnpm qa` will insist on.
import { existsSync } from "node:fs";
import { parseEnvFile } from "@critical-labs/qa-conductor/config";
import { allowUnfirewalled, qaCacheDir, qaEnvFile } from "./config.js";
import { DDB_LOCAL_URL, ddbLocalHome, installDynamoDbLocal, isInstalled, javaBinary } from "./dynamodb-local.js";
import { assertJavaInboundBlocked } from "./firewall.js";

const fail = (err: unknown): never => {
  console.error(`[qa:setup] ${(err as Error).message}`);
  process.exit(1);
};

const home = ddbLocalHome(qaCacheDir());
if (await isInstalled(home)) {
  console.log(`[qa:setup] DynamoDB Local is already installed in ${home}`);
} else {
  console.log(`[qa:setup] downloading ${DDB_LOCAL_URL}…`);
  await installDynamoDbLocal({ home }).catch(fail);
  console.log(`[qa:setup] checksum verified; installed DynamoDB Local in ${home}`);
}

const java = await javaBinary().catch(fail);
console.log(`[qa:setup] Java: ${java}`);

const envFile = qaEnvFile();
const fileEnv = existsSync(envFile) ? parseEnvFile(envFile) : {};
try {
  await assertJavaInboundBlocked(java, { allowUnfirewalled: allowUnfirewalled(fileEnv, process.env) });
  console.log("[qa:setup] firewall: inbound connections to that Java binary are blocked");
} catch (err) {
  // Setup is otherwise done: print the commands, and exit non-zero so the
  // missing rule isn't mistaken for success.
  console.error(`[qa:setup] ${(err as Error).message}`);
  process.exitCode = 1;
}
if (!existsSync(envFile)) console.log(`[qa:setup] next: create ${envFile} (see README "Side-by-side PR QA")`);
