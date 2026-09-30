import { join } from "node:path";
import type { Adapters } from "@critical-labs/qa-conductor";
import { createWorktreeBuild } from "@critical-labs/qa-conductor/adapters/build-worktree";
import { createProcessProvisioner } from "@critical-labs/qa-conductor/adapters/provisioner-process";
import type { Github } from "@critical-labs/qa-conductor/github";
import { createAuth } from "./auth.js";
import type { QaConfig } from "./config.js";
import { assertInstalled, createDynamoDbLocal, ddbLocalHome } from "./dynamodb-local.js";
import { derivePaneEnv, prodEnvFrom } from "./env.js";
import { createSeed } from "./seed.js";
import { createSnapshotLoader, describeMailDomain, type Snapshot } from "./snapshot.js";

/** The same pnpm major as CI. Scripts and pnpmfiles never run: installing a
 *  PR must not execute its code (or its dependencies') before the reviewer
 *  chose to boot it. */
const INSTALL = {
  cmd: "npx",
  args: ["-y", "pnpm@9.15.9", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"],
};

/** agent-identity's five qa-conductor seams, plus the base env they derive
 *  pane envs from. `java` is the resolved Java binary (see javaBinary), the
 *  one the firewall rule blocks.
 *
 *  Layout under `cacheDir`: `build/` (git worktrees), `state/` (the
 *  provisioner's pidfile) and `dynamodb-local/` (installed by qa:setup).
 *
 *  `onSnapshot` sees each prod snapshot, with its drop report, once.
 *
 *  `verifyInstall` runs before each pane's emulator starts; by default it
 *  re-checks every DynamoDB Local file against the pins in source.
 *
 *  `readBaseEnv`'s MAIL_DOMAIN is QA_MAIL_DOMAIN when set, else the domain
 *  the snapshot derives from the agents' addresses. */
export function createQaAdapters({ cfg, github, cacheDir, java, onSnapshot, verifyInstall }: {
  cfg: QaConfig;
  github: Github;
  cacheDir: string;
  java: string;
  onSnapshot?: (snapshot: Snapshot) => void;
  verifyInstall?: () => Promise<void>;
}): { adapters: Adapters; readBaseEnv: () => Promise<Record<string, string>> } {
  const { app } = cfg;
  const ddbHome = ddbLocalHome(cacheDir);
  const verify = verifyInstall ?? (() => assertInstalled(ddbHome));

  // The trust gate is the one real boundary between a PR's code and the
  // reviewer's machine. Authors with write access pass as usual; the listed
  // logins pass without it, still only from this repo or their own fork.
  const build = createWorktreeBuild({
    repo: cfg.repo,
    cacheDir: join(cacheDir, "build"),
    github,
    baseRef: app.baseRef,
    trust: { logins: app.trustedLogins },
    install: INSTALL,
    servicesFor: (dir) => ({ api: dir }),
  });

  const processes = createProcessProvisioner({
    stateDir: join(cacheDir, "state"),
    database: createDynamoDbLocal({ home: ddbHome, java }),
    // Started directly, never through a package manager (qa-conductor's
    // launch contract). PORT and the rest come from derivePaneEnv.
    command: ({ ref }) => ({
      cmd: join(ref, "node_modules/.bin/tsx"),
      args: ["packages/api/src/dev.ts"],
      cwd: ref,
    }),
    // /ui/ answers 200 with no credentials; /ui would redirect.
    healthPath: "/ui/",
    healthy: (status) => status === 200,
  });
  // Java runs whatever is in the DynamoDB Local home. `pnpm qa` checked it
  // at start, but a pane's code runs as the same user and could change it
  // during a session, so every file is checked again before each emulator
  // starts. (The provisioner builds the command synchronously, so the check
  // wraps provisionDatabase.)
  const provisioner: Adapters["provisioner"] = {
    ...processes,
    async provisionDatabase(args) {
      await verify();
      return processes.provisionDatabase(args);
    },
  };

  // One memoized snapshot for the seed's items and the base env's mail
  // domain: whichever asks first scans prod, and the other reuses the scan.
  const snapshot = createSnapshotLoader({ stackName: app.stackName, region: app.awsRegion, onLoaded: onSnapshot });

  // The override wins without waiting for a scan. The domain is never put
  // in an error or a log line: logs may be pasted publicly.
  async function mailDomain(): Promise<string> {
    if (app.mailDomain) return app.mailDomain;
    const loaded = await snapshot();
    if (loaded.mailDomain === null) {
      throw new Error(`the mail domain is ${describeMailDomain(loaded)}: set QA_MAIL_DOMAIN in .env.qa and restart pnpm qa`);
    }
    return loaded.mailDomain;
  }

  return {
    adapters: {
      build,
      provisioner,
      seed: createSeed({ snapshot: async () => (await snapshot()).items }),
      envTransform: { derivePaneEnv },
      auth: createAuth(),
    },
    readBaseEnv: async () => prodEnvFrom({ ...app, mailDomain: await mailDomain() }),
  };
}
