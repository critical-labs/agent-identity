import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installSkill, mergeMcpJson, skillDest, validateApiUrl } from "./setup.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aid-setup-"));

describe("validateApiUrl", () => {
  it("accepts a reachable API that answers 401", async () => {
    expect(await validateApiUrl("https://api.example", async () => ({ status: 401 })))
      .toBeUndefined();
  });

  it("strips a trailing slash before probing /me", async () => {
    let probed = "";
    await validateApiUrl("https://api.example/", async (url) => {
      probed = url;
      return { status: 401 };
    });
    expect(probed).toBe("https://api.example/me");
  });

  it("rejects unexpected statuses with the observed status", async () => {
    const err = await validateApiUrl("https://api.example", async () => ({ status: 404 }));
    expect(err).toMatch(/unexpected response 404/);
  });

  it("rejects unreachable hosts with the failure message", async () => {
    const err = await validateApiUrl("https://api.example", async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    expect(err).toMatch(/could not reach/);
    expect(err).toMatch(/ENOTFOUND/);
  });
});

describe("mergeMcpJson", () => {
  it("creates a fresh document when none exists", () => {
    const doc = JSON.parse(mergeMcpJson(undefined, { apiUrl: "https://api", requireGithub: false }));
    expect(doc.mcpServers["agent-identity"]).toEqual({
      command: "npx",
      args: ["agent-identity-mcp"],
      env: { AGENT_IDENTITY_API_URL: "https://api" },
    });
  });

  it("sets AGENT_IDENTITY_REQUIRE=github when asked", () => {
    const doc = JSON.parse(mergeMcpJson(undefined, { apiUrl: "https://api", requireGithub: true }));
    expect(doc.mcpServers["agent-identity"].env.AGENT_IDENTITY_REQUIRE).toBe("github");
  });

  it("preserves other servers and top-level keys", () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: "x" } },
      unrelated: true,
    });
    const doc = JSON.parse(mergeMcpJson(existing, { apiUrl: "https://api", requireGithub: false }));
    expect(doc.mcpServers.other).toEqual({ command: "x" });
    expect(doc.unrelated).toBe(true);
    expect(doc.mcpServers["agent-identity"].env.AGENT_IDENTITY_API_URL).toBe("https://api");
  });

  it("throws on unparseable JSON instead of clobbering", () => {
    expect(() => mergeMcpJson("{nope", { apiUrl: "https://api", requireGithub: false }))
      .toThrow(/not valid JSON/);
  });
});

describe("installSkill", () => {
  it("copies the skill directory into .claude/skills/agent-identity", () => {
    const src = tmp();
    writeFileSync(join(src, "SKILL.md"), "# skill");
    const repo = tmp();
    const dest = installSkill(src, repo);
    expect(dest).toBe(skillDest(repo));
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("# skill");
  });

  it("throws when the skill source is missing", () => {
    const repo = tmp();
    expect(() => installSkill(join(repo, "nope"), repo)).toThrow(/skill files not found/);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
  });
});
