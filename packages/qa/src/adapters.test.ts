import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeBuild } from "@critical-labs/qa-conductor/adapters/build-worktree";
import { createProcessProvisioner } from "@critical-labs/qa-conductor/adapters/provisioner-process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQaAdapters } from "./adapters.js";
import { loadQaConfig } from "./config.js";
import { derivePaneEnv } from "./env.js";
import { createSnapshotLoader } from "./snapshot.js";

// The real qa-conductor factories, wrapped so the options they get can be read.
vi.mock("@critical-labs/qa-conductor/adapters/build-worktree", async (importOriginal) => {
  const real = await importOriginal<typeof import("@critical-labs/qa-conductor/adapters/build-worktree")>();
  return { ...real, createWorktreeBuild: vi.fn(real.createWorktreeBuild) };
});
vi.mock("@critical-labs/qa-conductor/adapters/provisioner-process", async (importOriginal) => {
  const real = await importOriginal<typeof import("@critical-labs/qa-conductor/adapters/provisioner-process")>();
  return { ...real, createProcessProvisioner: vi.fn(real.createProcessProvisioner) };
});
vi.mock("./snapshot.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./snapshot.js")>();
  return { ...real, createSnapshotLoader: vi.fn(() => async () => []) };
});

const JAVA = "/jdk/bin/java";

function setup(extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "qa-adapters-"));
  const envFile = join(dir, ".env.qa");
  writeFileSync(envFile, ["GITHUB_QA_TOKEN=test-token", "QA_MAIL_DOMAIN=mail.example.test", ...extra].join("\n"));
  const cfg = loadQaConfig(envFile);
  const cacheDir = join(dir, "cache");
  const github = { prInfo: vi.fn(), authorPermission: vi.fn(async () => "read") };
  const qa = createQaAdapters({ cfg, github: github as never, cacheDir, java: JAVA });
  return { cfg, cacheDir, github, ...qa };
}

beforeEach(() => {
  vi.mocked(createWorktreeBuild).mockClear();
  vi.mocked(createProcessProvisioner).mockClear();
  vi.mocked(createSnapshotLoader).mockClear();
});

describe("build", () => {
  it("builds this repo's worktrees under the cache, trusting the configured logins", () => {
    const { cfg, cacheDir, github } = setup();
    const opts = vi.mocked(createWorktreeBuild).mock.calls[0][0];
    expect(opts).toMatchObject({
      repo: "critical-labs/agent-identity",
      cacheDir: join(cacheDir, "build"),
      baseRef: "main",
      trust: { logins: ["critical-agent-zero"] },
    });
    expect(opts.github).toBe(github);
    expect(cfg.app.trustedLogins).toEqual(["critical-agent-zero"]);
    // Only the logins are set: associations, requirePush and allowForks keep their defaults.
    expect(Object.keys(opts.trust!)).toEqual(["logins"]);
  });

  it("installs with CI's pnpm major, skipping scripts and pnpmfiles", () => {
    setup();
    expect(vi.mocked(createWorktreeBuild).mock.calls[0][0].install).toEqual({
      cmd: "npx",
      args: ["-y", "pnpm@9.15.9", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"],
    });
  });

  it("serves each checkout as the api service", async () => {
    setup();
    const { servicesFor } = vi.mocked(createWorktreeBuild).mock.calls[0][0];
    expect(await servicesFor("/cache/build/worktrees/abc", { role: "pr", sha: "abc" })).toEqual({ api: "/cache/build/worktrees/abc" });
  });

  it("honours QA_BASE_REF and QA_TRUSTED_LOGINS", () => {
    setup(["QA_BASE_REF=release", "QA_TRUSTED_LOGINS=alice,bob"]);
    expect(vi.mocked(createWorktreeBuild).mock.calls[0][0]).toMatchObject({
      baseRef: "release", trust: { logins: ["alice", "bob"] },
    });
  });

  describe("the trust gate it gets", () => {
    const pr = (author: string, association: string, headOwner = author) => ({
      number: 7, headSha: "a".repeat(40), author, authorAssociation: association,
      headRepo: `${headOwner}/agent-identity`, headOwner,
    });

    it("lets the agent's fork PRs boot without write access", async () => {
      const { adapters } = setup();
      const [row] = await adapters.build.describePrs!([pr("critical-agent-zero", "NONE")]);
      expect(row.status).not.toBe("blocked");
    });

    it("still blocks other authors without write access", async () => {
      const { adapters } = setup();
      const [stranger, readOnly] = await adapters.build.describePrs!([pr("mallory", "NONE"), pr("carol", "COLLABORATOR")]);
      expect(stranger).toMatchObject({ status: "blocked", reason: expect.stringMatching(/NONE is not trusted/) });
      expect(readOnly).toMatchObject({ status: "blocked", reason: expect.stringMatching(/push access is required/) });
    });

    it("still blocks the agent's login on a head in someone else's fork", async () => {
      const { adapters } = setup();
      const [row] = await adapters.build.describePrs!([pr("critical-agent-zero", "NONE", "mallory")]);
      expect(row).toMatchObject({ status: "blocked", reason: expect.stringMatching(/fork/) });
    });
  });
});

describe("provisioner", () => {
  it("keeps its pidfile under the cache and runs DynamoDB Local per pane", () => {
    const { cacheDir } = setup();
    const opts = vi.mocked(createProcessProvisioner).mock.calls[0][0];
    expect(opts.stateDir).toBe(join(cacheDir, "state"));
    const spec = opts.database!.command({ paneRef: { role: "base" }, port: 40000 });
    expect(spec.cmd).toBe(JAVA);
    expect(spec.cwd).toBe(join(cacheDir, "dynamodb-local"));
    expect(spec.args).toContain(join(cacheDir, "dynamodb-local", "DynamoDBLocal.jar"));
  });

  it("launches the dev server directly with the checkout's tsx, never via a package manager", () => {
    setup();
    const { command } = vi.mocked(createProcessProvisioner).mock.calls[0][0];
    const spec = command({ name: "api", ref: "/cache/build/worktrees/abc", port: 50124, env: {}, paneRef: { role: "pr" } });
    expect(spec).toEqual({
      cmd: "/cache/build/worktrees/abc/node_modules/.bin/tsx",
      args: ["packages/api/src/dev.ts"],
      cwd: "/cache/build/worktrees/abc",
    });
  });

  it("counts a pane healthy only once /ui/ answers 200", () => {
    setup();
    const opts = vi.mocked(createProcessProvisioner).mock.calls[0][0];
    expect(opts.healthPath).toBe("/ui/");
    expect(opts.healthy!(200)).toBe(true);
    for (const status of [301, 302, 401, 404, 500]) expect(opts.healthy!(status)).toBe(false);
  });
});

describe("seed, envTransform, auth and the base env", () => {
  it("seeds from one shared snapshot of the configured stack", () => {
    const { adapters } = setup(["QA_STACK_NAME=AgentIdentityStaging"]);
    expect(createSnapshotLoader).toHaveBeenCalledOnce();
    expect(createSnapshotLoader).toHaveBeenCalledWith({ stackName: "AgentIdentityStaging" });
    expect(adapters.seed.databases).toEqual(["agent-identity-qa"]);
  });

  it("uses the pane env transform and the viewer-key bootstrap", () => {
    const { adapters } = setup();
    expect(adapters.envTransform.derivePaneEnv).toBe(derivePaneEnv);
    expect(adapters.auth.requiresDb).toBe(true);
  });

  it("derives the pane's prod env from the QA config", async () => {
    const { readBaseEnv } = setup(["QA_PUBLIC_REPOS=o/a", "QA_AUTO_CAPABILITIES=email"]);
    expect(await readBaseEnv()).toEqual({ MAIL_DOMAIN: "mail.example.test", PUBLIC_REPOS: "o/a", AUTO_CAPABILITIES: "email" });
  });
});
