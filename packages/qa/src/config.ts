import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type ConductorConfig } from "@critical-labs/qa-conductor/config";

/** The repository root (this file is packages/qa/src/config.ts). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Core keys, defaulted for this repo and a loopback-only harness. */
export const QA_DEFAULTS: Record<string, string> = {
  QA_REPO: "critical-labs/agent-identity",
  QA_BASE_ORIGIN: "http://127.0.0.1:3101",
  QA_PR_ORIGIN: "http://127.0.0.1:3102",
};

/** The agent contributes fork-and-PR with read-only access. Trusting its
 *  login here is a local decision to run its PRs; it grants nothing on GitHub. */
const DEFAULT_TRUSTED_LOGINS = "critical-agent-zero";

export interface QaAppConfig {
  /** The prod mail domain, so the fleet mail redaction behaves as in prod. */
  mailDomain: string;
  publicRepos: string;
  autoCapabilities: string;
  /** PR authors trusted without write access (QA_TRUSTED_LOGINS). */
  trustedLogins: string[];
  baseRef: string;
  stackName: string;
}

export interface QaConfig extends ConductorConfig {
  app: QaAppConfig;
}

const list = (value: string) => value.split(",").map((s) => s.trim()).filter(Boolean);

/** agent-identity's own keys, from the raw `.env.qa` map. */
function appConfig(env: Record<string, string>): QaAppConfig {
  return {
    mailDomain: env.QA_MAIL_DOMAIN,
    publicRepos: env.QA_PUBLIC_REPOS ?? "",
    autoCapabilities: env.QA_AUTO_CAPABILITIES ?? "",
    // `??`, not `||`: an explicitly empty value means "no extra logins".
    trustedLogins: list(env.QA_TRUSTED_LOGINS ?? DEFAULT_TRUSTED_LOGINS),
    baseRef: env.QA_BASE_REF || "main",
    stackName: env.QA_STACK_NAME || "AgentIdentity",
  };
}

/** Load `.env.qa` through qa-conductor's loadConfig (which requires
 *  GITHUB_QA_TOKEN; here QA_MAIL_DOMAIN too). The token must be able to
 *  comment and label on the repo: the reviewer's, never the agent's. */
export function loadQaConfig(envFile: string): QaConfig {
  const cfg = loadConfig(envFile, { defaults: QA_DEFAULTS, required: ["QA_MAIL_DOMAIN"] });
  return { ...cfg, app: appConfig(cfg.env) };
}

export function qaEnvFile(env: Record<string, string | undefined> = process.env): string {
  return env.QA_ENV_FILE || join(REPO_ROOT, ".env.qa");
}

/** Builds, the pidfile and DynamoDB Local live under
 *  `$XDG_CACHE_HOME/qa-conductor/agent-identity` (default `~/.cache/…`). */
export function qaCacheDir(env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), ".cache");
  return join(base, "qa-conductor", "agent-identity");
}

/** QA_ALLOW_UNFIREWALLED=1, from `.env.qa` or the environment: the explicit
 *  override on platforms where the firewall rule can't be checked. */
export function allowUnfirewalled(...envs: Record<string, string | undefined>[]): boolean {
  return envs.some((env) => env.QA_ALLOW_UNFIREWALLED === "1");
}
