import { join } from "node:path";
import type { Adapters } from "@critical-labs/qa-conductor";
import { createWorktreeBuild } from "@critical-labs/qa-conductor/adapters/build-worktree";
import { createProcessProvisioner } from "@critical-labs/qa-conductor/adapters/provisioner-process";
import type { Github } from "@critical-labs/qa-conductor/github";
import { createAuth } from "./auth.js";
import type { QaConfig } from "./config.js";
import { createDynamoDbLocal, ddbLocalHome } from "./dynamodb-local.js";
import { derivePaneEnv, prodEnvFrom } from "./env.js";
import { createSeed } from "./seed.js";
import { createSnapshotLoader, type Snapshot } from "./snapshot.js";

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
 *  `onSnapshot` sees each prod snapshot, with its drop report, once. */
export function createQaAdapters({ cfg, github, cacheDir, java, onSnapshot }: {
  cfg: QaConfig;
  github: Github;
  cacheDir: string;
  java: string;
  onSnapshot?: (snapshot: Snapshot) => void;
}): { adapters: Adapters; readBaseEnv: () => Promise<Record<string, string>> } {
  const { app } = cfg;

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

  const provisioner = createProcessProvisioner({
    stateDir: join(cacheDir, "state"),
    database: createDynamoDbLocal({ home: ddbLocalHome(cacheDir), java }),
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

  return {
    adapters: {
      build,
      provisioner,
      seed: createSeed({
        snapshot: createSnapshotLoader({ stackName: app.stackName, region: app.awsRegion, onLoaded: onSnapshot }),
      }),
      envTransform: { derivePaneEnv },
      auth: createAuth(),
    },
    readBaseEnv: async () => prodEnvFrom(app),
  };
}
