import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type FetchLike = (url: string) => Promise<{ status: number }>;

/** Returns an error message, or undefined when the URL answers like an agent-identity API. */
export async function validateApiUrl(
  apiUrl: string,
  fetchFn: FetchLike = (url) => globalThis.fetch(url),
): Promise<string | undefined> {
  const probe = `${apiUrl.replace(/\/+$/, "")}/me`;
  let status: number;
  try {
    status = (await fetchFn(probe)).status;
  } catch (err) {
    return `could not reach ${probe}: ${(err as Error).message}`;
  }
  if (status !== 401) {
    return `unexpected response ${status} from ${probe} (expected 401 from an agent-identity API)`;
  }
  return undefined;
}

export interface McpEntryOptions {
  apiUrl: string;
  requireGithub: boolean;
}

export function mergeMcpJson(existing: string | undefined, opts: McpEntryOptions): string {
  let doc: Record<string, unknown>;
  if (existing === undefined || existing.trim() === "") {
    doc = {};
  } else {
    try {
      doc = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new Error(".mcp.json exists but is not valid JSON; fix it and re-run setup");
    }
  }
  const servers = { ...(doc.mcpServers as Record<string, unknown> | undefined) };
  servers["agent-identity"] = {
    command: "npx",
    args: ["agent-identity-mcp"],
    env: {
      AGENT_IDENTITY_API_URL: opts.apiUrl,
      ...(opts.requireGithub ? { AGENT_IDENTITY_REQUIRE: "github" } : {}),
    },
  };
  return `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`;
}

export const skillDest = (repoRoot: string): string =>
  join(repoRoot, ".claude", "skills", "agent-identity");

export function installSkill(skillSrcDir: string, repoRoot: string): string {
  if (!existsSync(join(skillSrcDir, "SKILL.md"))) {
    throw new Error(`skill files not found at ${skillSrcDir}`);
  }
  const dest = skillDest(repoRoot);
  mkdirSync(dest, { recursive: true });
  cpSync(skillSrcDir, dest, { recursive: true });
  return dest;
}
