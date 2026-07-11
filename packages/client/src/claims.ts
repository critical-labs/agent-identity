import type { Keypair } from "@agent-identity/shared";
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { defaultProfileDir } from "./profile.js";

export interface GithubLink {
  username: string;
  credentialRef?: string; // reference (e.g. op://...), never a plaintext credential
}

export interface PoolProfile extends Keypair {
  agentId?: string;
  address?: string;
  github?: GithubLink;
}

export const poolDir = (base: string = defaultProfileDir()): string => join(base, "pool");
export const claimsDir = (base: string = defaultProfileDir()): string => join(base, "claims");

export function listPool(base?: string): Array<{ name: string; profile: PoolProfile }> {
  let files: string[];
  try {
    files = readdirSync(poolDir(base)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Array<{ name: string; profile: PoolProfile }> = [];
  for (const f of files.sort()) {
    try {
      out.push({
        name: f.slice(0, -".json".length),
        profile: JSON.parse(readFileSync(join(poolDir(base), f), "utf8")) as PoolProfile,
      });
    } catch {
      console.warn(`agent-identity: skipping corrupt pool profile ${f}`);
    }
  }
  return out;
}

export function hasCapabilities(profile: PoolProfile, require: string[]): boolean {
  return require.every((cap) => (cap === "github" ? profile.github !== undefined : false));
}

export function savePoolProfile(
  profile: PoolProfile & { agentId: string }, base?: string,
): string {
  mkdirSync(poolDir(base), { recursive: true });
  writeFileSync(
    join(poolDir(base), `${profile.agentId}.json`),
    JSON.stringify(profile, null, 2),
    { mode: 0o600 },
  );
  return profile.agentId;
}

export function linkGithub(agentId: string, link: GithubLink, base?: string): void {
  const file = join(poolDir(base), `${agentId}.json`);
  let profile: PoolProfile;
  try {
    profile = JSON.parse(readFileSync(file, "utf8")) as PoolProfile;
  } catch {
    throw new Error(`no pool profile named ${agentId} in ${poolDir(base)}`);
  }
  writeFileSync(file, JSON.stringify({ ...profile, github: link }, null, 2), { mode: 0o600 });
}

export interface Claim {
  name: string;
  profile: PoolProfile;
  release(): void;
}

export interface ClaimOptions {
  base?: string;
  require?: string[];
  exclude?: string[];
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; anything else (ESRCH) = dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function tryLock(
  base: string | undefined, name: string, pid: number, isAlive: (pid: number) => boolean,
): Promise<boolean> {
  mkdirSync(claimsDir(base), { recursive: true });
  const lockPath = join(claimsDir(base), `${name}.lock`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid, claimedAt: new Date().toISOString(), host: hostname() }),
        { flag: "wx", mode: 0o600 },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: number | undefined;
      try {
        holder = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }).pid;
      } catch {
        // unreadable/corrupt lock counts as stale
      }
      if (holder !== undefined && isAlive(holder)) return false;
      try {
        unlinkSync(lockPath);
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code !== "ENOENT") throw err2;
      }
      await sleep(Math.random() * 25); // jitter between takeover attempts
    }
  }
  return false;
}

function makeClaim(base: string | undefined, name: string, profile: PoolProfile): Claim {
  return {
    name,
    profile,
    release: () => {
      try {
        unlinkSync(join(claimsDir(base), `${name}.lock`));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}

export async function claimFromPool(opts: ClaimOptions = {}): Promise<Claim | undefined> {
  const { base, require = [], exclude = [], pid = process.pid, isAlive = defaultIsAlive } = opts;
  for (const { name, profile } of listPool(base)) {
    if (exclude.includes(name) || !hasCapabilities(profile, require)) continue;
    if (await tryLock(base, name, pid, isAlive)) return makeClaim(base, name, profile);
  }
  return undefined;
}

export async function claimSpecific(
  name: string, opts: ClaimOptions = {},
): Promise<Claim | undefined> {
  const { base, pid = process.pid, isAlive = defaultIsAlive } = opts;
  const entry = listPool(base).find((p) => p.name === name);
  if (!entry) return undefined;
  if (await tryLock(base, name, pid, isAlive)) return makeClaim(base, name, entry.profile);
  return undefined;
}
