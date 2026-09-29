import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DDB_LOCAL_FILES, DDB_LOCAL_SHA256, QA_REGION, QA_TABLE, assertInstalled, checkInstall, createDynamoDbLocal,
  ddbLocalHome, formatMarker, installDynamoDbLocal, isInstalled, javaBinary, localClient, parseJavaMajor,
  parseMarker, sha256File, verifySha256,
} from "./dynamodb-local.js";

const ddb = mockClient(DynamoDBClient);
beforeEach(() => ddb.reset());

const paneRef = { role: "pr" as const };
const noSleep = async () => {};

describe("the database plugin", () => {
  const plugin = createDynamoDbLocal({ home: "/cache/dynamodb-local", java: "/jdk/bin/java", sleepFn: noSleep });

  it("runs DynamoDB Local in memory, shared, without telemetry, on the given port", () => {
    expect(plugin.command({ paneRef, port: 43210 })).toEqual({
      cmd: "/jdk/bin/java",
      args: [
        "-Djava.library.path=/cache/dynamodb-local/DynamoDBLocal_lib",
        "-jar", "/cache/dynamodb-local/DynamoDBLocal.jar",
        "-inMemory", "-sharedDb", "-disableTelemetry",
        "-port", "43210",
      ],
      cwd: "/cache/dynamodb-local",
    });
  });

  it("hands the pane a loopback endpoint and the QA table", () => {
    expect(plugin.handle({ paneRef, port: 43210 })).toEqual({
      dsn: "http://127.0.0.1:43210",
      db: { endpoint: "http://127.0.0.1:43210", tableName: "agent-identity-qa", region: "us-east-1" },
    });
    expect(QA_TABLE).toBe("agent-identity-qa");
    expect(QA_REGION).toBe("us-east-1");
  });

  it("is ready once ListTables answers, polling until then", async () => {
    ddb.on(ListTablesCommand)
      .rejectsOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
      .rejectsOnce(new Error("socket hang up"))
      .resolves({ TableNames: [] });
    await plugin.ready({ port: 43210, signal: new AbortController().signal });
    const calls = ddb.commandCalls(ListTablesCommand);
    expect(calls).toHaveLength(3);
    // Each attempt carries its own abort signal: the per-call timeout.
    for (const call of calls) expect((call.args as unknown[])[1]).toMatchObject({ abortSignal: expect.any(AbortSignal) });
  });

  it("stops polling when the boot is aborted", async () => {
    ddb.on(ListTablesCommand).rejects(new Error("connect ECONNREFUSED"));
    const ctl = new AbortController();
    let sleeps = 0;
    const aborting = createDynamoDbLocal({
      home: "/h", java: "/j",
      sleepFn: async () => { if (++sleeps === 3) ctl.abort(); },
    });
    await expect(aborting.ready({ port: 1234, signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(ddb.commandCalls(ListTablesCommand)).toHaveLength(3);
  });
});

describe("localClient", () => {
  it("talks to the pane endpoint with the fixed dummy credentials", async () => {
    const client = localClient({ endpoint: "http://127.0.0.1:43210", tableName: QA_TABLE, region: QA_REGION });
    expect(await client.config.region()).toBe("us-east-1");
    expect(await client.config.credentials()).toMatchObject({ accessKeyId: "local", secretAccessKey: "local" });
    const endpoint = await client.config.endpoint!();
    expect(endpoint).toMatchObject({ protocol: "http:", hostname: "127.0.0.1", port: 43210 });
  });

  it("refuses anything but a loopback http endpoint", () => {
    for (const endpoint of ["https://dynamodb.us-east-1.amazonaws.com", "http://10.0.0.5:8000", "http://127.0.0.1.example.test:8000"]) {
      expect(() => localClient({ endpoint, tableName: QA_TABLE, region: QA_REGION })).toThrow(/loopback/);
    }
  });
});

describe("parseJavaMajor", () => {
  it.each([
    ['openjdk version "25.0.1" 2025-10-21 LTS', 25],
    ['openjdk version "17" 2021-09-14', 17],
    ['java version "21.0.2" 2024-01-16 LTS', 21],
    ['java version "1.8.0_392"', 8],
    ["no version here", null],
  ])("%s → %s", (text, major) => {
    expect(parseJavaMajor(text)).toBe(major);
  });
});

describe("javaBinary", () => {
  const versionOut = (v: string) => ({ stdout: "", stderr: `openjdk version "${v}" 2025-10-21 LTS\n` });

  it("on macOS resolves the real binary under java_home, not the /usr/bin stub", async () => {
    const execFileFn = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "/usr/libexec/java_home") {
        expect(args).toEqual(["-v", "17+"]);
        return { stdout: "/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home\n", stderr: "" };
      }
      return versionOut("21.0.2");
    });
    const realpathFn = vi.fn(async (p: string) => p);
    const java = await javaBinary({ platform: "darwin", env: {}, execFileFn, realpathFn });
    expect(java).toBe("/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin/java");
    expect(execFileFn).toHaveBeenLastCalledWith(java, ["-version"]);
  });

  it("returns the symlink-free path, so the firewall rule and the process agree", async () => {
    const execFileFn = vi.fn(async (cmd: string) =>
      cmd === "/usr/libexec/java_home" ? { stdout: "/Library/Java/JavaVirtualMachines/jdk.jdk/Contents/Home", stderr: "" } : versionOut("21"));
    const realpathFn = async () => "/opt/jdk-21/bin/java";
    expect(await javaBinary({ platform: "darwin", env: {}, execFileFn, realpathFn })).toBe("/opt/jdk-21/bin/java");
  });

  it("explains how to get Java 17+ when java_home finds none", async () => {
    const execFileFn = vi.fn(async () => { throw new Error("Unable to find any JVMs matching version \"17+\"."); });
    await expect(javaBinary({ platform: "darwin", env: {}, execFileFn, realpathFn: async (p) => p }))
      .rejects.toThrow(/Java 17 or later/);
  });

  it("refuses a Java older than 17", async () => {
    const execFileFn = vi.fn(async () => ({ stdout: "", stderr: 'java version "1.8.0_392"\n' }));
    await expect(javaBinary({ platform: "linux", env: { JAVA_HOME: "/usr/lib/jvm/java-8" }, execFileFn, realpathFn: async (p) => p }))
      .rejects.toThrow(/Java 17 or later.*found 8/);
  });

  it("elsewhere uses JAVA_HOME when set", async () => {
    const execFileFn = vi.fn(async () => versionOut("17.0.9"));
    const java = await javaBinary({ platform: "linux", env: { JAVA_HOME: "/usr/lib/jvm/java-17" }, execFileFn, realpathFn: async (p) => p });
    expect(java).toBe("/usr/lib/jvm/java-17/bin/java");
  });

  it("elsewhere finds java on PATH without JAVA_HOME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-java-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "java"), "#!/bin/sh\n", { mode: 0o755 });
    const execFileFn = vi.fn(async () => versionOut("21"));
    const java = await javaBinary({
      platform: "linux", env: { PATH: `/nonexistent:${join(dir, "bin")}` }, execFileFn, realpathFn: async (p) => p,
    });
    expect(java).toBe(join(dir, "bin", "java"));
  });
});

const sha256Of = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

describe("the pinned file manifest", () => {
  it("pins the jar, every library jar and the native libraries, each by relative path", () => {
    const paths = Object.keys(DDB_LOCAL_FILES);
    expect(paths).toContain("DynamoDBLocal.jar");
    expect(paths).toContain("DynamoDBLocal_lib/sqlite4java.jar");
    expect(paths).toContain("DynamoDBLocal_lib/libsqlite4java-osx-aarch64.dylib");
    expect(paths).toContain("DynamoDBLocal_lib/libsqlite4java-linux-amd64.so");
    expect(paths.filter((p) => p.startsWith("DynamoDBLocal_lib/")).length).toBeGreaterThan(100);
    for (const [path, sha] of Object.entries(DDB_LOCAL_FILES)) {
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      expect(path).toMatch(/^[\w.-]+(\/[\w.-]+)*$/);
      expect(path.split("/")).not.toContain("..");
    }
  });
});

describe("the install marker", () => {
  const tarball = sha256Of("tarball");

  it("records the tarball pin and reads it back", () => {
    expect(formatMarker({ tarball })).toBe(`tarball ${tarball}\n`);
    expect(parseMarker(formatMarker({ tarball }))).toEqual({ tarball });
  });

  it("ignores the jar line earlier installs wrote: the files are checked against the source", () => {
    expect(parseMarker(`tarball ${tarball}\njar ${sha256Of("jar")}\n`)).toEqual({ tarball });
  });

  it("rejects a marker without a tarball checksum, such as the first install format", () => {
    expect(parseMarker(`${tarball}\n`)).toBeNull();
    expect(parseMarker(`jar ${sha256Of("jar")}\n`)).toBeNull();
    expect(parseMarker("tarball not-a-sha\n")).toBeNull();
    expect(parseMarker("")).toBeNull();
  });
});

describe("sha256File", () => {
  it("hashes a file's contents", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "qa-hash-")), "f");
    writeFileSync(path, "some jar bytes");
    expect(await sha256File(path)).toBe(sha256Of("some jar bytes"));
  });
});

// A stand-in for the tarball's contents, and the manifest that pins them.
const contents: Record<string, string> = {
  "DynamoDBLocal.jar": "jar",
  "DynamoDBLocal_lib/sqlite4java.jar": "library jar",
  "DynamoDBLocal_lib/libsqlite4java-osx.dylib": "native library",
  "README.txt": "readme",
};
const files = Object.fromEntries(Object.entries(contents).map(([rel, data]) => [rel, sha256Of(data)]));

function layOut(dir: string, tree: Record<string, string>): void {
  for (const [rel, data] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), data);
  }
}

describe("checkInstall (a real tree, with an injected manifest)", () => {
  const tarball = sha256Of("tarball");
  const opts = { sha256: tarball, files };

  function fakeInstall(tree: Record<string, string> = contents, { marker = true } = {}): string {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    mkdirSync(home);
    layOut(home, tree);
    if (marker) writeFileSync(join(home, ".sha256"), formatMarker({ tarball }));
    return home;
  }

  it("accepts a home holding exactly the pinned files, re-hashing every one on every call", async () => {
    const home = fakeInstall();
    const hashFile = vi.fn(sha256File);
    expect(await checkInstall(home, { ...opts, hashFile })).toEqual({ ok: true });
    expect(await checkInstall(home, { ...opts, hashFile })).toEqual({ ok: true });
    expect(hashFile).toHaveBeenCalledTimes(2 * Object.keys(files).length);
    expect(hashFile.mock.calls.map(([path]) => path)).toContain(join(home, "DynamoDBLocal_lib", "libsqlite4java-osx.dylib"));
    await expect(assertInstalled(home, opts)).resolves.toBeUndefined();
  });

  it.each([
    ["the jar", "DynamoDBLocal.jar"],
    ["a library jar the jar's Class-Path names", "DynamoDBLocal_lib/sqlite4java.jar"],
    ["a native library", "DynamoDBLocal_lib/libsqlite4java-osx.dylib"],
  ])("refuses %s changed after setup, naming the pinned and the actual checksum", async (_what, rel) => {
    const home = fakeInstall();
    writeFileSync(join(home, rel), "patched");
    expect(await isInstalled(home, opts)).toBe(false);
    await expect(assertInstalled(home, opts)).rejects.toThrow(new RegExp(
      `changed since pnpm qa:setup: .*${rel}.*does not match its pinned checksum .*${files[rel]}.*${sha256Of("patched")}.*run pnpm qa:setup`,
    ));
  });

  it("checks against the pins in source: rewriting the marker can't vouch for a changed file", async () => {
    const home = fakeInstall();
    writeFileSync(join(home, "DynamoDBLocal.jar"), "patched");
    writeFileSync(join(home, ".sha256"), `tarball ${tarball}\njar ${sha256Of("patched")}\n`);
    expect(await isInstalled(home, opts)).toBe(false);
  });

  it.each([
    ["a jar", "DynamoDBLocal_lib/extra.jar"],
    ["a native library", "DynamoDBLocal_lib/libextra.dylib"],
    ["a file at the classpath root (the jar's Class-Path lists .)", "log4j2.xml"],
    ["a class in a new directory", "com/example/Extra.class"],
  ])("refuses %s the tarball doesn't have", async (_what, rel) => {
    const home = fakeInstall({ ...contents, [rel]: "extra" });
    await expect(assertInstalled(home, opts)).rejects.toThrow(/is not part of DynamoDB Local.*run pnpm qa:setup/);
  });

  it("refuses a pinned file replaced by a symlink, even to identical bytes", async () => {
    const home = fakeInstall();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "qa-elsewhere-")), "DynamoDBLocal.jar");
    writeFileSync(elsewhere, contents["DynamoDBLocal.jar"]);
    rmSync(join(home, "DynamoDBLocal.jar"));
    symlinkSync(elsewhere, join(home, "DynamoDBLocal.jar"));
    await expect(assertInstalled(home, opts)).rejects.toThrow(/DynamoDBLocal.jar is not a regular file/);
  });

  it("refuses a missing file", async () => {
    const { "DynamoDBLocal_lib/sqlite4java.jar": _missing, ...rest } = contents;
    await expect(assertInstalled(fakeInstall(rest), opts)).rejects.toThrow(/sqlite4java.jar is missing.*run pnpm qa:setup/);
  });

  it("refuses a file it cannot hash", async () => {
    const hashFile = async () => { throw new Error("EACCES"); };
    await expect(assertInstalled(fakeInstall(), { ...opts, hashFile }))
      .rejects.toThrow(/could not check the DynamoDB Local install .*EACCES.*run pnpm qa:setup/);
  });

  it("refuses an install from another tarball, without hashing anything", async () => {
    const hashFile = vi.fn(sha256File);
    await expect(assertInstalled(fakeInstall(), { ...opts, sha256: "0".repeat(64), hashFile }))
      .rejects.toThrow(/not the pinned version.*run pnpm qa:setup/);
    expect(hashFile).not.toHaveBeenCalled();
  });

  it("refuses an install whose marker predates the current format", async () => {
    const home = fakeInstall(contents, { marker: false });
    writeFileSync(join(home, ".sha256"), `${tarball}\n`);
    await expect(assertInstalled(home, opts)).rejects.toThrow(/predates the current install format.*run pnpm qa:setup/);
  });

  it("reports a missing install", async () => {
    for (const home of [ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-"))), fakeInstall(contents, { marker: false })]) {
      expect(await checkInstall(home, opts)).toEqual({ ok: false, reason: `DynamoDB Local is not installed in ${home}` });
    }
  });
});

describe("install helpers", () => {
  const tarball = Buffer.from("pretend this is dynamodb_local_latest.tar.gz");
  const sha = createHash("sha256").update(tarball).digest("hex");

  // A stand-in for `tar -xzf <file> -C <dir>`: lays out what the "tarball" holds.
  const fakeTar = vi.fn(async (cmd: string, args: string[]) => {
    expect(cmd).toBe("tar");
    layOut(args[args.indexOf("-C") + 1], contents);
    return { stdout: "", stderr: "" };
  });
  const download = (body: Buffer) => vi.fn(async () => new Response(new Uint8Array(body)));

  beforeEach(() => { fakeTar.mockClear(); });

  it("pins a SHA-256", () => {
    expect(DDB_LOCAL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifySha256 accepts the pinned bytes and names both digests otherwise", () => {
    expect(() => verifySha256(tarball, sha)).not.toThrow();
    expect(() => verifySha256(Buffer.from("tampered"), sha)).toThrow(new RegExp(`expected ${sha}.*got [0-9a-f]{64}.*DDB_LOCAL_FILES`));
  });

  it("refuses a download that does not match, and writes nothing", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    await expect(installDynamoDbLocal({
      home, sha256: sha, files, fetchFn: download(Buffer.from("something else")), execFileFn: fakeTar,
    })).rejects.toThrow(/checksum mismatch/);
    expect(fakeTar).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(false);
    expect(await isInstalled(home, { sha256: sha, files })).toBe(false);
  });

  it("refuses a failed download", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    const fetchFn = vi.fn(async () => new Response("nope", { status: 403 }));
    await expect(installDynamoDbLocal({ home, sha256: sha, files, fetchFn, execFileFn: fakeTar })).rejects.toThrow(/403/);
    expect(fakeTar).not.toHaveBeenCalled();
  });

  it("extracts a matching download into the home, checks every file and records the tarball pin", async () => {
    const cache = mkdtempSync(join(tmpdir(), "qa-cache-"));
    const home = ddbLocalHome(cache);
    expect(home).toBe(join(cache, "dynamodb-local"));
    const hashFile = vi.fn(sha256File);
    await installDynamoDbLocal({ home, sha256: sha, files, fetchFn: download(tarball), execFileFn: fakeTar, hashFile });
    expect(fakeTar).toHaveBeenCalledOnce();
    expect(hashFile).toHaveBeenCalledTimes(Object.keys(files).length);
    expect(readFileSync(join(home, "DynamoDBLocal.jar"), "utf8")).toBe("jar");
    expect(readFileSync(join(home, ".sha256"), "utf8")).toBe(`tarball ${sha}\n`);
    await expect(assertInstalled(home, { sha256: sha, files })).resolves.toBeUndefined();
  });

  it("refuses a tarball whose files don't match the manifest, keeping the old install", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    await installDynamoDbLocal({ home, sha256: sha, files, fetchFn: download(tarball), execFileFn: fakeTar });
    const stale = { ...files, "DynamoDBLocal.jar": sha256Of("the previous release's jar") };
    await expect(installDynamoDbLocal({ home, sha256: sha, files: stale, fetchFn: download(tarball), execFileFn: fakeTar }))
      .rejects.toThrow(/does not match DDB_LOCAL_FILES .*DynamoDBLocal.jar.*bump DDB_LOCAL_FILES/);
    await expect(assertInstalled(home, { sha256: sha, files })).resolves.toBeUndefined();
  });

  it("refuses a library modified after install until setup reinstalls it", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    await installDynamoDbLocal({ home, sha256: sha, files, fetchFn: download(tarball), execFileFn: fakeTar });
    writeFileSync(join(home, "DynamoDBLocal_lib", "sqlite4java.jar"), "library jar, patched");
    writeFileSync(join(home, "log4j2.xml"), "<Configuration/>");
    expect(await isInstalled(home, { sha256: sha, files })).toBe(false);
    await installDynamoDbLocal({ home, sha256: sha, files, fetchFn: download(tarball), execFileFn: fakeTar });
    expect(existsSync(join(home, "log4j2.xml"))).toBe(false);
    await expect(assertInstalled(home, { sha256: sha, files })).resolves.toBeUndefined();
  });

  it("treats an install from another checksum as missing", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    await installDynamoDbLocal({ home, sha256: sha, files, fetchFn: download(tarball), execFileFn: fakeTar });
    expect(await isInstalled(home, { sha256: "0".repeat(64), files })).toBe(false);
    await expect(assertInstalled(home, { sha256: "0".repeat(64), files })).rejects.toThrow(/pnpm qa:setup/);
  });
});
