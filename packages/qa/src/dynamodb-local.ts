// DynamoDB Local (the official emulator, a Java program) as the per-pane
// database for qa-conductor's process provisioner, plus the helpers that
// install it once (`pnpm qa:setup`) and check the install (`pnpm qa`).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import type { ProcessDatabase } from "@critical-labs/qa-conductor/adapters/provisioner-process";

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
/** DynamoDB Local 3.3.1. */
export const DDB_LOCAL_SHA256 = "f80bcec477f85f57e2c77f8d54aa6b672a8403fceff0c450560aee1cf6c21163";

const JAR = "DynamoDBLocal.jar";
const LIB = "DynamoDBLocal_lib";
/** Written last by an install: the checksum of the tarball it came from. */
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
      "next to it, then bump DDB_LOCAL_SHA256 in packages/qa/src/dynamodb-local.ts.",
    );
  }
}

/** Installed = the jar and its libraries are present, and the marker says
 *  they came from the pinned tarball. */
export async function isInstalled(home: string, sha256 = DDB_LOCAL_SHA256): Promise<boolean> {
  try {
    const [marker] = await Promise.all([
      readFile(join(home, MARKER), "utf8"),
      access(join(home, JAR)),
      access(join(home, LIB)),
    ]);
    return marker.trim() === sha256;
  } catch {
    return false;
  }
}

export async function assertInstalled(home: string, sha256 = DDB_LOCAL_SHA256): Promise<void> {
  if (!(await isInstalled(home, sha256))) {
    throw new Error(`DynamoDB Local is not installed in ${home} (or is not the pinned version): run pnpm qa:setup`);
  }
}

/** Download, verify, extract. Nothing touches the disk until the checksum
 *  matches, and the new tree replaces the old one only once it's complete. */
export async function installDynamoDbLocal({
  home,
  url = DDB_LOCAL_URL,
  sha256 = DDB_LOCAL_SHA256,
  fetchFn = fetch,
  execFileFn = execFileAsync,
}: {
  home: string;
  url?: string;
  sha256?: string;
  fetchFn?: (url: string) => Promise<Response>;
  execFileFn?: ExecFileFn;
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
    try {
      await access(join(tree, JAR));
    } catch {
      throw new Error(`the DynamoDB Local tarball has no ${JAR}`);
    }
    await writeFile(join(tree, MARKER), `${sha256}\n`);
    await rm(home, { recursive: true, force: true });
    await rename(tree, home);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
