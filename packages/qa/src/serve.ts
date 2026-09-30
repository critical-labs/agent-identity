// `pnpm qa`: side-by-side PR QA. The harness listens on 127.0.0.1:3100 and
// the base and PR panes on 3101 / 3102. See README "Side-by-side PR QA".
import { readFile } from "node:fs/promises";
import { startConductor } from "@critical-labs/qa-conductor";
import { createGithub } from "@critical-labs/qa-conductor/github";
import { createQaAdapters } from "./adapters.js";
import { allowUnfirewalled, loadQaConfig, qaCacheDir, qaEnvFile } from "./config.js";
import { assertInstalled, ddbLocalHome, javaBinary } from "./dynamodb-local.js";
import { assertJavaInboundBlocked } from "./firewall.js";
import { describeSnapshot, type Snapshot } from "./snapshot.js";

/** One preflight check: on failure, say what's wrong and how to fix it, and
 *  exit non-zero before anything starts. */
async function check<T>(what: string, run: () => T | Promise<T>, fix?: string): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`[qa] ${what}: ${(err as Error).message}`);
    if (fix) console.error(`[qa] ${fix}`);
    process.exit(1);
  }
}

await check("node", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`qa-conductor needs Node 22 or later; this is ${process.versions.node}`);
});
const envFile = qaEnvFile();
// QA_MAIL_DOMAIN is optional: without it, the panes' mail domain comes from
// the snapshot, so it can only be missing once the first pane boots.
const cfg = await check("config", () => loadQaConfig(envFile), `create or fix ${envFile}: see README "Side-by-side PR QA"`);
const cacheDir = qaCacheDir();
const java = await check("java", () => javaBinary());
await check("firewall", () => assertJavaInboundBlocked(java, { allowUnfirewalled: allowUnfirewalled(cfg.env, process.env) }));
// Re-hashes every DynamoDB Local file against the pins in source, and
// refuses any extra file; the provisioner checks again before each pane.
await check("DynamoDB Local", () => assertInstalled(ddbLocalHome(cacheDir)));

const github = createGithub({
  token: cfg.githubToken,
  repo: cfg.repo,
  qaLabels: [cfg.verdictLabels.accept, cfg.verdictLabels.reject],
});
// Once per snapshot: what the panes get, what was dropped per kind of item
// (key prefixes only, never values), and where the mail domain comes from
// (counts only, never the domain), with a warning when QA_MAIL_DOMAIN
// matches at most half of the agents' addresses.
const onSnapshot = (snapshot: Snapshot) =>
  console.log(`[qa] ${describeSnapshot(snapshot, { mailDomainOverride: cfg.app.mailDomain })}`);
const { adapters, readBaseEnv } = createQaAdapters({ cfg, github, cacheDir, java, onSnapshot });
const conductor = startConductor({ cfg, github, fsx: { readFile: (path) => readFile(path) }, adapters, readBaseEnv });

// The first signal tears the panes down gracefully. A second one exits at
// once; process.exit still runs the provisioner's exit hook, which SIGKILLs
// every pane process group (a default signal death would not).
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[qa] ${sig}: tearing the panes down…`);
    conductor.shutdown().then(
      () => process.exit(0),
      (err: Error) => {
        console.error(`[qa] shutdown failed: ${err.message}`);
        process.exit(1);
      },
    );
  });
}

console.log(`[qa] harness: http://${cfg.host}:${cfg.ports.harness}/`);
