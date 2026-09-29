// DynamoDB Local (the official emulator, a Java program) as the per-pane
// database for qa-conductor's process provisioner, plus the helpers that
// install it once (`pnpm qa:setup`) and check the install (`pnpm qa`, and
// before each pane's emulator starts).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import type { ProcessDatabase } from "@critical-labs/qa-conductor/adapters/provisioner-process";
import { DDB_LOCAL_FILES } from "./dynamodb-local-files.js";

export { DDB_LOCAL_FILES };

/** Every pane's table. The name is local to each pane's own emulator. */
export const QA_TABLE = "agent-identity-qa";
export const QA_REGION = "us-east-1";
/** Fixed dummy credentials for every emulator call, harness and pane alike.
 *  DynamoDB Local runs with -sharedDb, so credentials don't partition data. */
export const LOCAL_CREDENTIALS = { accessKeyId: "local", secretAccessKey: "local" } as const;

/** AWS's official download. AWS publishes only a moving "latest" tarball, so
 *  the checksum below is what pins the version: when AWS ships a release,
 *  setup refuses it until the pin is bumped (after checking the .sha256 AWS
 *  publishes next to the tarball). */
export const DDB_LOCAL_URL = "https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz";
/** DynamoDB Local 3.3.1. Bump DDB_LOCAL_FILES (dynamodb-local-files.ts),
 *  the checksum of every file it extracts, together with it. */
export const DDB_LOCAL_SHA256 = "f80bcec477f85f57e2c77f8d54aa6b672a8403fceff0c450560aee1cf6c21163";

const JAR = "DynamoDBLocal.jar";
const LIB = "DynamoDBLocal_lib";
/** Written last by an install: the checksum of the tarball it came from (see
 *  formatMarker). It only marks the install complete; what Java runs is
 *  checked against DDB_LOCAL_FILES, pinned in source. */
const MARKER = ".sha256";
const JAVA_HOME_TOOL = "/usr/libexec/java_home";
const MIN_JAVA = 17;

/** The adapter-private `db` a pane carries from provisionDatabase to the
 *  seed and the auth bootstrap. */
export interface PaneDb {
  endpoint: string;
  tableName: string;
  region: string;
}

export type ExecFileFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const execFileAsync: ExecFileFn = promisify(execFile);

export const ddbLocalHome = (cacheDir: string): string => join(cacheDir, "dynamodb-local");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A client for one pane's emulator. It refuses anything but a loopback
 *  http endpoint, so a harness-side write can never reach a real table. */
export function localClient(db: PaneDb, { maxAttempts }: { maxAttempts?: number } = {}): DynamoDBClient {
  let url: URL | null = null;
  try { url = new URL(db.endpoint); } catch { /* refused below */ }
  if (!url || url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    throw new Error(`refusing a non-loopback DynamoDB endpoint for a QA pane: ${db.endpoint}`);
  }
  return new DynamoDBClient({
    endpoint: db.endpoint,
    region: QA_REGION,
    credentials: LOCAL_CREDENTIALS,
    ...(maxAttempts ? { maxAttempts } : {}),
  });
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** The `database` plugin for createProcessProvisioner: one in-memory
 *  emulator per pane. `java` is the resolved binary (see javaBinary), which
 *  must be the one the firewall rule blocks. */
export function createDynamoDbLocal({
  home, java, sleepFn = defaultSleep, attemptTimeoutMs = 1000, retryMs = 250,
}: {
  home: string;
  java: string;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  attemptTimeoutMs?: number;
  retryMs?: number;
}): ProcessDatabase<PaneDb> {
  const handle = ({ port }: { port: number }) => {
    const endpoint = `http://127.0.0.1:${port}`;
    return { dsn: endpoint, db: { endpoint, tableName: QA_TABLE, region: QA_REGION } };
  };

  return {
    command: ({ port }) => ({
      cmd: java,
      args: [
        `-Djava.library.path=${join(home, LIB)}`,
        "-jar", join(home, JAR),
        "-inMemory", "-sharedDb", "-disableTelemetry",
        "-port", String(port),
      ],
      cwd: home,
    }),

    // Up once ListTables answers. Each attempt has its own short timeout, and
    // the SDK's own retries are off, so a slow start is simply polled again.
    async ready({ port, signal }) {
      const client = localClient(handle({ port }).db, { maxAttempts: 1 });
      try {
        for (;;) {
          if (signal?.aborted) throw abortError();
          const timeout = AbortSignal.timeout(attemptTimeoutMs);
          const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          try {
            await client.send(new ListTablesCommand({ Limit: 1 }), { abortSignal });
            return;
          } catch {
            // not listening yet
          }
          if (signal?.aborted) throw abortError();
          await sleepFn(retryMs, signal);
        }
      } finally {
        client.destroy();
      }
    },

    handle,
  };
}

// --- Java -----------------------------------------------------------------

/** The major version from `java -version` output ("1.8" style → 8). */
export function parseJavaMajor(text: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  const first = Number(m[1]);
  return first === 1 && m[2] !== undefined ? Number(m[2]) : first;
}

async function onPath(name: string, path = ""): Promise<string | null> {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** The real Java binary DynamoDB Local runs under, symlinks resolved. On
 *  macOS that's `$(java_home)/bin/java`, not the /usr/bin/java stub, which
 *  execs a different binary: the firewall rule must name the process that
 *  actually listens. Requires Java 17 or later. */
export async function javaBinary({
  platform = process.platform,
  env = process.env,
  execFileFn = execFileAsync,
  realpathFn = realpath,
}: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  execFileFn?: ExecFileFn;
  realpathFn?: (path: string) => Promise<string>;
} = {}): Promise<string> {
  const need = `DynamoDB Local needs Java ${MIN_JAVA} or later`;
  let candidate: string | null;
  if (platform === "darwin") {
    try {
      const { stdout } = await execFileFn(JAVA_HOME_TOOL, ["-v", `${MIN_JAVA}+`]);
      candidate = join(stdout.trim(), "bin", "java");
    } catch (err) {
      throw new Error(`${need}, and ${JAVA_HOME_TOOL} found none (${(err as Error).message.trim()}). Install a JDK, e.g. Temurin 21, then retry.`);
    }
  } else {
    candidate = env.JAVA_HOME ? join(env.JAVA_HOME, "bin", "java") : await onPath("java", env.PATH);
    if (!candidate) throw new Error(`${need}: set JAVA_HOME or put java on PATH.`);
  }

  let java: string;
  try {
    java = await realpathFn(candidate);
  } catch {
    throw new Error(`${need}: ${candidate} does not exist.`);
  }
  const { stdout, stderr } = await execFileFn(java, ["-version"]);
  const major = parseJavaMajor(`${stderr}\n${stdout}`);
  if (major === null || major < MIN_JAVA) {
    throw new Error(`${need}, but found ${major ?? "an unknown version"} at ${java}.`);
  }
  return java;
}

// --- install ----------------------------------------------------------------

export function verifySha256(data: Uint8Array, expected: string): void {
  const got = createHash("sha256").update(data).digest("hex");
  if (got !== expected) {
    throw new Error(
      `DynamoDB Local checksum mismatch: expected ${expected}, got ${got}. ` +
      `AWS may have published a new release at ${DDB_LOCAL_URL}: check the .sha256 AWS publishes ` +
      "next to it, then bump DDB_LOCAL_SHA256 in packages/qa/src/dynamodb-local.ts and, with it, " +
      "DDB_LOCAL_FILES in packages/qa/src/dynamodb-local-files.ts.",
    );
  }
}

/** SHA-256 of a file, streamed (the jar is several MB). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** What an install records: the checksum of the tarball it came from (the
 *  pin it passed). Written last, so it also marks the install complete. */
export interface InstallMarker {
  tarball: string;
}

export const formatMarker = ({ tarball }: InstallMarker): string => `tarball ${tarball}\n`;

/** The marker's tarball checksum, or null when it has none (as in a marker
 *  from before this format). Other lines, such as the `jar` line earlier
 *  installs wrote, are ignored: the files are checked against the source. */
export function parseMarker(text: string): InstallMarker | null {
  for (const line of text.split("\n")) {
    const m = /^tarball ([0-9a-f]{64})$/.exec(line.trim());
    if (m) return { tarball: m[1] };
  }
  return null;
}

/** path → SHA-256, relative to the install's home (see DDB_LOCAL_FILES). */
export type FileManifest = Readonly<Record<string, string>>;

/** The first way the tree under `home` differs from `files`, or null when
 *  it matches exactly. Java's classpath includes the home itself (the jar's
 *  Class-Path lists `.`) and it loads native libraries from
 *  DynamoDBLocal_lib, so any other file is refused, not only a changed one.
 *  So is anything that isn't a plain file or directory: a symlink could be
 *  pointed elsewhere after the check. `skip` names top-level entries that
 *  aren't DynamoDB Local's (the install marker). Every file is re-hashed. */
export async function findTreeProblem(home: string, files: FileManifest, {
  hashFile = sha256File,
  skip = [],
}: {
  hashFile?: (path: string) => Promise<string>;
  skip?: string[];
} = {}): Promise<string | null> {
  // The directories the files live in, relative to home ("" is home).
  const dirs = new Set([""]);
  for (const rel of Object.keys(files)) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }

  const found = new Set<string>();
  const walk = async (rel: string): Promise<string | null> => {
    const path = rel ? join(home, rel) : home;
    const st = await lstat(path);
    if (st.isDirectory()) {
      if (!dirs.has(rel)) return `${path} is not part of DynamoDB Local`;
      for (const name of (await readdir(path)).sort()) {
        if (!rel && skip.includes(name)) continue;
        const problem = await walk(rel ? `${rel}/${name}` : name);
        if (problem) return problem;
      }
      return null;
    }
    if (!st.isFile()) return `${path} is not a regular file`;
    if (!Object.hasOwn(files, rel)) return `${path} is not part of DynamoDB Local`;
    found.add(rel);
    return null;
  };
  const extra = await walk("");
  if (extra) return extra;

  const expected = Object.keys(files).sort();
  const missing = expected.find((rel) => !found.has(rel));
  if (missing) return `${join(home, missing)} is missing`;
  const hashes = await Promise.all(expected.map((rel) => hashFile(join(home, rel))));
  const changed = expected.findIndex((rel, i) => hashes[i] !== files[rel]);
  if (changed !== -1) {
    const rel = expected[changed];
    return `${join(home, rel)} does not match its pinned checksum (expected ${files[rel]}, got ${hashes[changed]})`;
  }
  return null;
}

export interface InstallCheckOptions {
  /** The tarball pin the marker must name. */
  sha256?: string;
  /** Every file the pinned tarball extracts, with its checksum. */
  files?: FileManifest;
  hashFile?: (path: string) => Promise<string>;
}

export type InstallState = { ok: true } | { ok: false; reason: string };

/** Installed = the marker says the install came from the pinned tarball,
 *  and the home holds exactly the files that tarball extracts, each with
 *  the checksum pinned in source (DDB_LOCAL_FILES), and nothing else. The
 *  reference lives in source, not next to the files, so rewriting the
 *  marker can't vouch for a changed file. Every file is re-hashed on every
 *  call: `pnpm qa` checks at start, and the provisioner again before each
 *  pane's emulator starts (see createQaAdapters). A process running as the
 *  same user could still swap a file between the check and Java reading
 *  it; the check catches a tree changed at rest. */
export async function checkInstall(home: string, {
  sha256 = DDB_LOCAL_SHA256,
  files = DDB_LOCAL_FILES,
  hashFile = sha256File,
}: InstallCheckOptions = {}): Promise<InstallState> {
  let text: string;
  try {
    text = await readFile(join(home, MARKER), "utf8");
  } catch {
    return { ok: false, reason: `DynamoDB Local is not installed in ${home}` };
  }
  const marker = parseMarker(text);
  if (!marker) return { ok: false, reason: `the DynamoDB Local install in ${home} predates the current install format` };
  if (marker.tarball !== sha256) return { ok: false, reason: `the DynamoDB Local install in ${home} is not the pinned version` };

  let problem: string | null;
  try {
    problem = await findTreeProblem(home, files, { hashFile, skip: [MARKER] });
  } catch (err) {
    return { ok: false, reason: `could not check the DynamoDB Local install in ${home}: ${(err as Error).message}` };
  }
  if (problem) return { ok: false, reason: `the DynamoDB Local install has changed since pnpm qa:setup: ${problem}` };
  return { ok: true };
}

export async function isInstalled(home: string, opts: InstallCheckOptions = {}): Promise<boolean> {
  return (await checkInstall(home, opts)).ok;
}

export async function assertInstalled(home: string, opts: InstallCheckOptions = {}): Promise<void> {
  const state = await checkInstall(home, opts);
  if (!state.ok) throw new Error(`${state.reason}: run pnpm qa:setup`);
}

/** Download, verify, extract, check every extracted file against
 *  DDB_LOCAL_FILES, and record the tarball's checksum. Nothing touches the
 *  disk until the tarball's checksum matches, and the new tree replaces the
 *  old one only once it's complete and checked. */
export async function installDynamoDbLocal({
  home,
  url = DDB_LOCAL_URL,
  sha256 = DDB_LOCAL_SHA256,
  files = DDB_LOCAL_FILES,
  fetchFn = fetch,
  execFileFn = execFileAsync,
  hashFile = sha256File,
}: {
  home: string;
  url?: string;
  sha256?: string;
  files?: FileManifest;
  fetchFn?: (url: string) => Promise<Response>;
  execFileFn?: ExecFileFn;
  hashFile?: (path: string) => Promise<string>;
}): Promise<void> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`downloading ${url} failed: HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  verifySha256(data, sha256);

  const parent = dirname(home);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, "dynamodb-local.staging-"));
  try {
    const archive = join(staging, "dynamodb_local.tar.gz");
    const tree = join(staging, "tree");
    await writeFile(archive, data, { mode: 0o600 });
    await mkdir(tree);
    await execFileFn("tar", ["-xzf", archive, "-C", tree]);
    const problem = await findTreeProblem(tree, files, { hashFile });
    if (problem) {
      throw new Error(
        `the extracted DynamoDB Local does not match DDB_LOCAL_FILES (${problem}); ` +
        "bump DDB_LOCAL_FILES in packages/qa/src/dynamodb-local-files.ts together with DDB_LOCAL_SHA256",
      );
    }
    await writeFile(join(tree, MARKER), formatMarker({ tarball: sha256 }));
    await rm(home, { recursive: true, force: true });
    await rename(tree, home);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
