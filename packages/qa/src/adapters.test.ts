import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createWorktreeBuild } from "@critical-labs/qa-conductor/adapters/build-worktree";
import { createProcessProvisioner } from "@critical-labs/qa-conductor/adapters/provisioner-process";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createQaAdapters } from "./adapters.js";
import { loadQaConfig } from "./config.js";
import { derivePaneEnv } from "./env.js";
import { createSeed } from "./seed.js";
import { createSnapshotLoader, describeSnapshot, type Snapshot } from "./snapshot.js";

// The real qa-conductor factories, wrapped so the options they get can be read.
vi.mock("@critical-labs/qa-conductor/adapters/build-worktree", async (importOriginal) => {
  const real = await importOriginal<typeof import("@critical-labs/qa-conductor/adapters/build-worktree")>();
  return { ...real, createWorktreeBuild: vi.fn(real.createWorktreeBuild) };
});
vi.mock("@critical-labs/qa-conductor/adapters/provisioner-process", async (importOriginal) => {
  const real = await importOriginal<typeof import("@critical-labs/qa-conductor/adapters/provisioner-process")>();
  return { ...real, createProcessProvisioner: vi.fn(real.createProcessProvisioner) };
});
vi.mock("./seed.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./seed.js")>();
  return { ...real, createSeed: vi.fn(real.createSeed) };
});

/** What the stand-in snapshot loaders resolve to; a test may change it. */
const stub = vi.hoisted(() => ({ snapshot: null as unknown as Snapshot }));

// A stand-in loader per createQaAdapters, so nothing reaches AWS unless a
// test puts the real one back.
vi.mock("./snapshot.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./snapshot.js")>();
  return { ...real, createSnapshotLoader: vi.fn(() => vi.fn(async () => stub.snapshot)) };
});

// Only the tests that put the real snapshot loader back reach these.
const cfnMock = mockClient(CloudFormationClient);
const docMock = mockClient(DynamoDBDocumentClient);

const JAVA = "/jdk/bin/java";

const snapshotAt = (mailDomain: string | null, { matching = 2, addresses = 2 } = {}): Snapshot => ({
  items: [
    { PK: "AGENT#fp1", SK: "AGENT", agentId: "482913", address: "a@mail.example.test" },
    { PK: "AGENT#fp2", SK: "AGENT", agentId: "731904", address: "b@mail.example.test" },
  ],
  dropped: {},
  droppedAttributes: {},
  mailDomain,
  mailDomainCounts: mailDomain === null ? { matching: 0, addresses } : { matching, addresses },
});

function setup(extra: string[] = [], { onSnapshot, verifyInstall }: {
  onSnapshot?: (snapshot: Snapshot) => void;
  verifyInstall?: () => Promise<void>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qa-adapters-"));
  const envFile = join(dir, ".env.qa");
  writeFileSync(envFile, ["GITHUB_QA_TOKEN=test-token", ...extra].join("\n"));
  const cfg = loadQaConfig(envFile);
  const cacheDir = join(dir, "cache");
  const github = { prInfo: vi.fn(), authorPermission: vi.fn(async () => "read") };
  const qa = createQaAdapters({ cfg, github: github as never, cacheDir, java: JAVA, onSnapshot, verifyInstall });
  return { cfg, cacheDir, github, ...qa };
}

/** The snapshot loader the nth createQaAdapters built, and the one its seed got. */
const loaderOf = (n = 0) => vi.mocked(createSnapshotLoader).mock.results[n].value as Mock<() => Promise<Snapshot>>;
const seedSnapshotOf = (n = 0) => vi.mocked(createSeed).mock.calls[n][0].snapshot;

beforeEach(() => {
  vi.mocked(createWorktreeBuild).mockClear();
  vi.mocked(createProcessProvisioner).mockClear();
  vi.mocked(createSnapshotLoader).mockClear();
  vi.mocked(createSeed).mockClear();
  stub.snapshot = snapshotAt("mail.example.test");
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

  describe("the DynamoDB Local check before each pane's emulator", () => {
    // A stand-in for the process provisioner, so nothing is spawned.
    const fakeProcesses = () => ({
      provisionDatabase: vi.fn(async () => ({ dsn: "http://127.0.0.1:40000", db: {} })),
      reserveServices: vi.fn(async () => ({})),
      launchServices: vi.fn(async () => {}),
      waitHealthy: vi.fn(async () => {}),
      teardown: vi.fn(async () => {}),
    });
    const args = { paneRef: { role: "pr" as const }, databases: ["agent-identity-qa"] };

    it("re-checks the install every time, before the emulator starts", async () => {
      const processes = fakeProcesses();
      vi.mocked(createProcessProvisioner).mockReturnValueOnce(processes);
      const order: string[] = [];
      const verifyInstall = vi.fn(async () => { order.push("verify"); });
      processes.provisionDatabase.mockImplementation(async () => {
        order.push("start");
        return { dsn: "http://127.0.0.1:40000", db: {} };
      });
      const { adapters } = setup([], { verifyInstall });
      expect(await adapters.provisioner.provisionDatabase(args)).toEqual({ dsn: "http://127.0.0.1:40000", db: {} });
      await adapters.provisioner.provisionDatabase(args);
      expect(order).toEqual(["verify", "start", "verify", "start"]);
      expect(processes.provisionDatabase).toHaveBeenCalledWith(args);
    });

    it("starts nothing when the install has changed", async () => {
      const processes = fakeProcesses();
      vi.mocked(createProcessProvisioner).mockReturnValueOnce(processes);
      const verifyInstall = vi.fn(async () => { throw new Error("DynamoDBLocal.jar does not match its pinned checksum: run pnpm qa:setup"); });
      const { adapters } = setup([], { verifyInstall });
      await expect(adapters.provisioner.provisionDatabase(args)).rejects.toThrow(/pinned checksum/);
      expect(processes.provisionDatabase).not.toHaveBeenCalled();
    });

    it("by default checks the install under the cache against the pinned files", async () => {
      const processes = fakeProcesses();
      vi.mocked(createProcessProvisioner).mockReturnValueOnce(processes);
      const { adapters, cacheDir } = setup();
      await expect(adapters.provisioner.provisionDatabase(args))
        .rejects.toThrow(`DynamoDB Local is not installed in ${join(cacheDir, "dynamodb-local")}: run pnpm qa:setup`);
      expect(processes.provisionDatabase).not.toHaveBeenCalled();
    });

    it("passes every other provisioner call straight through", () => {
      const processes = fakeProcesses();
      vi.mocked(createProcessProvisioner).mockReturnValueOnce(processes);
      const { adapters } = setup([], { verifyInstall: async () => {} });
      expect(adapters.provisioner.launchServices).toBe(processes.launchServices);
      expect(adapters.provisioner.teardown).toBe(processes.teardown);
      expect(adapters.provisioner.waitHealthy).toBe(processes.waitHealthy);
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
    expect(vi.mocked(createSnapshotLoader).mock.calls[0][0].stackName).toBe("AgentIdentityStaging");
    expect(adapters.seed.databases).toEqual(["agent-identity-qa"]);
  });

  it("scans in QA_AWS_REGION when set, else in the default chain's region", () => {
    setup(["QA_AWS_REGION=eu-west-1"]);
    expect(vi.mocked(createSnapshotLoader).mock.calls[0][0].region).toBe("eu-west-1");
    setup();
    expect(vi.mocked(createSnapshotLoader).mock.calls[1][0].region).toBeUndefined();
  });

  it("hands every loaded snapshot, with its drop report, to onSnapshot", () => {
    const onSnapshot = vi.fn();
    setup([], { onSnapshot });
    expect(vi.mocked(createSnapshotLoader).mock.calls[0][0].onLoaded).toBe(onSnapshot);
  });

  it("uses the pane env transform and the viewer-key bootstrap", () => {
    const { adapters } = setup();
    expect(adapters.envTransform.derivePaneEnv).toBe(derivePaneEnv);
    expect(adapters.auth.requiresDb).toBe(true);
  });

  it("seeds each pane with the shared snapshot's items", async () => {
    setup();
    expect(await seedSnapshotOf()()).toBe(stub.snapshot.items);
    expect(loaderOf()).toHaveBeenCalledOnce();
  });

  it("takes MAIL_DOMAIN from the snapshot the seed loads, and the rest from the QA config", async () => {
    const { readBaseEnv } = setup(["QA_PUBLIC_REPOS=o/a", "QA_AUTO_CAPABILITIES=email"]);
    expect(await readBaseEnv()).toEqual({ MAIL_DOMAIN: "mail.example.test", PUBLIC_REPOS: "o/a", AUTO_CAPABILITIES: "email" });
    // The same loader as the seed's, not a second one.
    expect(createSnapshotLoader).toHaveBeenCalledOnce();
    expect(loaderOf()).toHaveBeenCalledOnce();
    await seedSnapshotOf()();
    expect(loaderOf()).toHaveBeenCalledTimes(2);
  });

  it("lets a QA_MAIL_DOMAIN override win, without waiting for the snapshot", async () => {
    const { readBaseEnv } = setup(["QA_MAIL_DOMAIN=override.example.test"]);
    expect(await readBaseEnv()).toEqual({ MAIL_DOMAIN: "override.example.test", PUBLIC_REPOS: "", AUTO_CAPABILITIES: "" });
    expect(loaderOf()).not.toHaveBeenCalled();
  });

  it("gives the panes a mixed-case QA_MAIL_DOMAIN lower-cased", async () => {
    const { readBaseEnv } = setup(["QA_MAIL_DOMAIN=Override.Example.Test"]);
    expect((await readBaseEnv()).MAIL_DOMAIN).toBe("override.example.test");
  });

  it("tells the reviewer to set QA_MAIL_DOMAIN when the snapshot can't give the domain", async () => {
    stub.snapshot = snapshotAt(null, { addresses: 4 });
    await expect(setup().readBaseEnv()).rejects.toThrow(
      "the mail domain is not derivable (the 4 agent address(es) are not all at one domain): " +
        "set QA_MAIL_DOMAIN in .env.qa and restart pnpm qa",
    );
    stub.snapshot = snapshotAt(null, { addresses: 0 });
    await expect(setup().readBaseEnv()).rejects.toThrow(
      "the mail domain is not derivable (no agent has a valid address): set QA_MAIL_DOMAIN in .env.qa and restart pnpm qa",
    );
  });

  it("fails as the snapshot does, so a later pane can retry", async () => {
    const { readBaseEnv } = setup();
    loaderOf().mockRejectedValueOnce(new Error("ExpiredToken"));
    await expect(readBaseEnv()).rejects.toThrow("ExpiredToken");
    expect((await readBaseEnv()).MAIL_DOMAIN).toBe("mail.example.test");
  });

  describe("with the real snapshot loader", () => {
    const items = snapshotAt("mail.example.test").items;

    beforeEach(async () => {
      const real = await vi.importActual<typeof import("./snapshot.js")>("./snapshot.js");
      vi.mocked(createSnapshotLoader).mockImplementationOnce(real.createSnapshotLoader);
      cfnMock.reset();
      docMock.reset();
      cfnMock.on(DescribeStackResourcesCommand).resolves({ StackResources: [
        { LogicalResourceId: "TableCD117FE6", ResourceType: "AWS::DynamoDB::Table", PhysicalResourceId: "AgentIdentity-Table" },
      ] as never });
      docMock.on(ScanCommand).resolves({ Items: items });
    });

    it("scans prod once for both the base env and the seed, whichever asks first", async () => {
      const { readBaseEnv } = setup();
      // The conductor seeds before it reads the base env, but nothing here relies on that.
      expect((await readBaseEnv()).MAIL_DOMAIN).toBe("mail.example.test");
      expect(await seedSnapshotOf()()).toEqual(items);
      expect(await readBaseEnv()).toEqual({ MAIL_DOMAIN: "mail.example.test", PUBLIC_REPOS: "", AUTO_CAPABILITIES: "" });
      expect(docMock.commandCalls(ScanCommand)).toHaveLength(1);
    });

    it("fails the boot when prod's agents span domains, rather than guess by majority", async () => {
      docMock.on(ScanCommand).resolves({ Items: [
        ...items,
        { PK: "AGENT#fp3", SK: "AGENT", agentId: "731905", address: "c@mail.example.test" },
        { PK: "AGENT#fp4", SK: "AGENT", agentId: "731906", address: "d@other.example.test" },
      ] });
      const { readBaseEnv } = setup();
      await expect(readBaseEnv()).rejects.toThrow(
        "the mail domain is not derivable (the 4 agent address(es) are not all at one domain): " +
          "set QA_MAIL_DOMAIN in .env.qa and restart pnpm qa",
      );
      // One scan all the same: the seed reuses it.
      expect(await seedSnapshotOf()()).toHaveLength(4);
      expect(docMock.commandCalls(ScanCommand)).toHaveLength(1);
    });

    it("logs nothing that names the mail domain", async () => {
      const logged: unknown[][] = [];
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); }));
      try {
        // As serve.ts logs each snapshot.
        const { readBaseEnv } = setup([], { onSnapshot: (s) => console.log(`[qa] ${describeSnapshot(s)}`) });
        await seedSnapshotOf()();
        expect((await readBaseEnv()).MAIL_DOMAIN).toBe("mail.example.test");
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect(logged).toHaveLength(1);
      expect(JSON.stringify(logged)).not.toMatch(/example|\.test/);
    });
  });
});
