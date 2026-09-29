import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DDB_LOCAL_SHA256, QA_REGION, QA_TABLE, assertInstalled, checkInstall, createDynamoDbLocal, ddbLocalHome,
  formatMarker, installDynamoDbLocal, isInstalled, javaBinary, localClient, parseJavaMajor, parseMarker,
  sha256File, verifySha256,
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

describe("the install marker", () => {
  const tarball = sha256Of("tarball");
  const jar = sha256Of("jar");

  it("records the tarball pin and the jar's checksum, and reads them back", () => {
    expect(formatMarker({ tarball, jar })).toBe(`tarball ${tarball}\njar ${jar}\n`);
    expect(parseMarker(formatMarker({ tarball, jar }))).toEqual({ tarball, jar });
  });

  it("rejects a marker without both checksums, such as one from before the jar was recorded", () => {
    expect(parseMarker(`${tarball}\n`)).toBeNull();
    expect(parseMarker(`tarball ${tarball}\n`)).toBeNull();
    expect(parseMarker(`jar ${jar}\n`)).toBeNull();
    expect(parseMarker(`tarball ${tarball}\njar not-a-sha\n`)).toBeNull();
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

describe("checkInstall (injected fs and hash)", () => {
  const home = "/cache/dynamodb-local";
  const tarball = sha256Of("tarball");
  const jar = sha256Of("jar");
  const fsWith = (marker: string | null, present = true) => ({
    readFile: vi.fn(async (path: string) => {
      if (path !== join(home, ".sha256") || marker === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return marker;
    }),
    access: vi.fn(async (path: string) => {
      if (!present) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }),
  });

  it("re-hashes the jar on every check and accepts it when it matches the marker", async () => {
    const hashFile = vi.fn(async () => jar);
    const fs = fsWith(formatMarker({ tarball, jar }));
    expect(await checkInstall(home, { sha256: tarball, fs, hashFile })).toEqual({ ok: true });
    expect(await checkInstall(home, { sha256: tarball, fs, hashFile })).toEqual({ ok: true });
    expect(hashFile).toHaveBeenCalledTimes(2);
    expect(hashFile).toHaveBeenCalledWith(join(home, "DynamoDBLocal.jar"));
    await expect(assertInstalled(home, { sha256: tarball, fs, hashFile })).resolves.toBeUndefined();
  });

  it("refuses a jar that changed after setup, naming both checksums", async () => {
    const changed = sha256Of("a different jar");
    const opts = { sha256: tarball, fs: fsWith(formatMarker({ tarball, jar })), hashFile: async () => changed };
    expect(await isInstalled(home, opts)).toBe(false);
    await expect(assertInstalled(home, opts)).rejects.toThrow(
      new RegExp(`DynamoDBLocal.jar .*changed since pnpm qa:setup.*${jar}.*${changed}.*run pnpm qa:setup`),
    );
  });

  it("refuses a jar it cannot read", async () => {
    const opts = { sha256: tarball, fs: fsWith(formatMarker({ tarball, jar })), hashFile: async () => { throw new Error("EACCES"); } };
    await expect(assertInstalled(home, opts)).rejects.toThrow(/could not hash .*DynamoDBLocal.jar.*EACCES.*run pnpm qa:setup/);
  });

  it("refuses an install from another tarball, without hashing the jar", async () => {
    const hashFile = vi.fn(async () => jar);
    const opts = { sha256: "0".repeat(64), fs: fsWith(formatMarker({ tarball, jar })), hashFile };
    await expect(assertInstalled(home, opts)).rejects.toThrow(/not the pinned version.*run pnpm qa:setup/);
    expect(hashFile).not.toHaveBeenCalled();
  });

  it("refuses an older install whose marker has no jar checksum", async () => {
    const opts = { sha256: tarball, fs: fsWith(`${tarball}\n`), hashFile: async () => jar };
    await expect(assertInstalled(home, opts)).rejects.toThrow(/no checksum for DynamoDBLocal.jar.*run pnpm qa:setup/);
  });

  it("reports a missing install", async () => {
    for (const fs of [fsWith(null), fsWith(formatMarker({ tarball, jar }), false)]) {
      expect(await checkInstall(home, { sha256: tarball, fs, hashFile: async () => jar }))
        .toEqual({ ok: false, reason: `DynamoDB Local is not installed in ${home}` });
    }
  });
});

describe("install helpers", () => {
  const tarball = Buffer.from("pretend this is dynamodb_local_latest.tar.gz");
  const sha = createHash("sha256").update(tarball).digest("hex");

  // A stand-in for `tar -xzf <file> -C <dir>`: lays out what the real tarball holds.
  const fakeTar = vi.fn(async (cmd: string, args: string[]) => {
    expect(cmd).toBe("tar");
    const dir = args[args.indexOf("-C") + 1];
    writeFileSync(join(dir, "DynamoDBLocal.jar"), "jar");
    mkdirSync(join(dir, "DynamoDBLocal_lib"));
    return { stdout: "", stderr: "" };
  });
  const download = (body: Buffer) => vi.fn(async () => new Response(new Uint8Array(body)));

  beforeEach(() => { fakeTar.mockClear(); });

  it("pins a SHA-256", () => {
    expect(DDB_LOCAL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifySha256 accepts the pinned bytes and names both digests otherwise", () => {
    expect(() => verifySha256(tarball, sha)).not.toThrow();
    expect(() => verifySha256(Buffer.from("tampered"), sha)).toThrow(new RegExp(`expected ${sha}.*got [0-9a-f]{64}`));
  });

  it("refuses a download that does not match, and writes nothing", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    await expect(installDynamoDbLocal({
      home, sha256: sha, fetchFn: download(Buffer.from("something else")), execFileFn: fakeTar,
    })).rejects.toThrow(/checksum mismatch/);
    expect(fakeTar).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(false);
    expect(await isInstalled(home, { sha256: sha })).toBe(false);
  });

  it("refuses a failed download", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    const fetchFn = vi.fn(async () => new Response("nope", { status: 403 }));
    await expect(installDynamoDbLocal({ home, sha256: sha, fetchFn, execFileFn: fakeTar })).rejects.toThrow(/403/);
    expect(fakeTar).not.toHaveBeenCalled();
  });

  it("extracts a matching download into the home and records the tarball pin and the jar's checksum", async () => {
    const cache = mkdtempSync(join(tmpdir(), "qa-cache-"));
    const home = ddbLocalHome(cache);
    expect(home).toBe(join(cache, "dynamodb-local"));
    await installDynamoDbLocal({ home, sha256: sha, fetchFn: download(tarball), execFileFn: fakeTar });
    expect(fakeTar).toHaveBeenCalledOnce();
    expect(existsSync(join(home, "DynamoDBLocal.jar"))).toBe(true);
    expect(readFileSync(join(home, ".sha256"), "utf8")).toBe(`tarball ${sha}\njar ${sha256Of("jar")}\n`);
    expect(await isInstalled(home, { sha256: sha })).toBe(true);
    await expect(assertInstalled(home, { sha256: sha })).resolves.toBeUndefined();
  });

  it("hashes the extracted jar with the injected hash", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    const hashFile = vi.fn(async () => "a".repeat(64));
    await installDynamoDbLocal({ home, sha256: sha, fetchFn: download(tarball), execFileFn: fakeTar, hashFile });
    expect(hashFile).toHaveBeenCalledOnce();
    expect(String(vi.mocked(hashFile).mock.calls[0]).endsWith("DynamoDBLocal.jar")).toBe(true);
    expect(parseMarker(readFileSync(join(home, ".sha256"), "utf8"))).toEqual({ tarball: sha, jar: "a".repeat(64) });
  });

  it("refuses a jar modified after install until setup reinstalls it", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    await installDynamoDbLocal({ home, sha256: sha, fetchFn: download(tarball), execFileFn: fakeTar });
    writeFileSync(join(home, "DynamoDBLocal.jar"), "jar, patched");
    expect(await isInstalled(home, { sha256: sha })).toBe(false);
    await expect(assertInstalled(home, { sha256: sha })).rejects.toThrow(/changed since pnpm qa:setup/);
    await installDynamoDbLocal({ home, sha256: sha, fetchFn: download(tarball), execFileFn: fakeTar });
    expect(readFileSync(join(home, "DynamoDBLocal.jar"), "utf8")).toBe("jar");
    await expect(assertInstalled(home, { sha256: sha })).resolves.toBeUndefined();
  });

  it("treats an install from another checksum as missing", async () => {
    const home = ddbLocalHome(mkdtempSync(join(tmpdir(), "qa-cache-")));
    await installDynamoDbLocal({ home, sha256: sha, fetchFn: download(tarball), execFileFn: fakeTar });
    expect(await isInstalled(home, { sha256: "0".repeat(64) })).toBe(false);
    await expect(assertInstalled(home, { sha256: "0".repeat(64) })).rejects.toThrow(/pnpm qa:setup/);
  });
});
