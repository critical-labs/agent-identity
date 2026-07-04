import { generateKeypair, type Keypair } from "@agent-identity/shared";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Profile extends Keypair {
  agentId?: string;
  address?: string;
}

export function defaultProfileDir(): string {
  return join(homedir(), ".config", "agent-identity");
}

export function loadOrCreateProfile(
  name: string = process.env.AGENT_IDENTITY_PROFILE ?? "default",
  dir: string = defaultProfileDir(),
): Profile {
  const file = join(dir, `${name}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Profile;
  } catch {
    mkdirSync(dir, { recursive: true });
    const profile: Profile = generateKeypair();
    writeFileSync(file, JSON.stringify(profile, null, 2), { mode: 0o600 });
    return profile;
  }
}

export function saveProfile(
  profile: Profile,
  name: string = process.env.AGENT_IDENTITY_PROFILE ?? "default",
  dir: string = defaultProfileDir(),
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(profile, null, 2), { mode: 0o600 });
}
