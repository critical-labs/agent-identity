import type { Keypair } from "@agent-identity/shared";
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
