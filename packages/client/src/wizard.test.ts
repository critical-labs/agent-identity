import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readFleetKeyFile, readMachineConfig } from "./config.js";
import { skillDest } from "./setup.js";
import { runSetup, type SetupDeps } from "./wizard.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aid-wiz-"));

function scripted(answers: string[]) {
  const said: string[] = [];
  return {
    io: {
      ask: async () => answers.shift() ?? "",
      say: (m: string) => { said.push(m); },
    },
    said,
  };
}

function makeDeps(answers: string[], over: Partial<SetupDeps> = {}) {
  const cwd = tmp();
  const base = tmp();
  const skillDir = tmp();
  writeFileSync(join(skillDir, "SKILL.md"), "# skill");
  const { io, said } = scripted(answers);
  const provision = vi.fn(async ({ count }: { count: number }) =>
    Array.from({ length: count }, (_, i) => ({ agentId: `10000${i}`, address: `10000${i}@d` })));
  const deps: SetupDeps = {
    io, cwd, base, skillDir,
    fetchFn: async () => ({ status: 401 }),
    provision: provision as never,
    ...over,
  };
  return { deps, said, cwd, base, provision };
}

describe("runSetup — connect to existing", () => {
  it("persists config, provisions, writes .mcp.json, installs the skill", async () => {
    // backend=1, apiUrl, fleetKey, count=2, requireGithub=y
    const { deps, cwd, base, provision } = makeDeps(["1", "https://api.example", "fk-1", "2", "y"]);
    await runSetup(deps);
    expect(readMachineConfig(base)).toEqual({ apiUrl: "https://api.example" });
    expect(readFleetKeyFile(base)).toBe("fk-1");
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, apiUrl: "https://api.example", fleetKey: "fk-1", base }),
    );
    const mcp = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["agent-identity"].env).toEqual({
      AGENT_IDENTITY_API_URL: "https://api.example",
      AGENT_IDENTITY_REQUIRE: "github",
    });
    expect(existsSync(join(skillDest(cwd), "SKILL.md"))).toBe(true);
  });

  it("re-prompts until the API URL validates", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 401 });
    const { deps, said } = makeDeps(["1", "https://bad", "https://good", "fk", "0", "n"], { fetchFn });
    await runSetup(deps);
    expect(said.some((m) => m.includes("unexpected response 500"))).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps an existing fleet key when the prompt is left empty", async () => {
    const { deps, base } = makeDeps(["1", "https://api", "", "0", "n"]);
    const { writeFleetKeyFile } = await import("./config.js");
    writeFleetKeyFile("existing-key", base);
    await runSetup(deps);
    expect(readFleetKeyFile(base)).toBe("existing-key");
  });

  it("aborts without touching a corrupt .mcp.json", async () => {
    const { deps, cwd } = makeDeps(["1", "https://api", "fk", "0", "n"]);
    writeFileSync(join(cwd, ".mcp.json"), "{nope");
    await expect(runSetup(deps)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe("{nope");
  });

  it("asks before overwriting an installed skill and honours 'n'", async () => {
    // extra final answer "n" for the overwrite prompt
    const { deps, cwd } = makeDeps(["1", "https://api", "fk", "0", "n", "n"]);
    mkdirSync(skillDest(cwd), { recursive: true });
    writeFileSync(join(skillDest(cwd), "SKILL.md"), "old");
    await runSetup(deps);
    expect(readFileSync(join(skillDest(cwd), "SKILL.md"), "utf8")).toBe("old");
  });
});

describe("runSetup — deploy new", () => {
  it("walks the checklist, re-verifying failed steps", async () => {
    const verifyResults = ["not yet", undefined]; // first check fails, second passes
    const checklistDeps = {
      run: vi.fn(async () => {
        const r = verifyResults.shift();
        return r === undefined ? { ok: true, output: '{"Rules":[]}' } : { ok: false, output: r };
      }),
      resolveMx: async () => [{ exchange: "mx" }],
    };
    // backend=2, domain, then: enter for clone, enter+enter for credentials (fail, retry),
    // enter for deploy, ses, (mx auto-passes needs enter), rule set, fleet key step,
    // then apiUrl, fleetKey, count=0, require=n
    const answers = ["2", "mail.example.com", "", "", "", "", "", "", "", "",
      "https://api.example", "fk", "0", "n"];
    const { deps, said } = makeDeps(answers, { checklistDeps });
    await runSetup(deps);
    expect(said.some((m) => m.includes("Clone the agent-identity repository"))).toBe(true);
    expect(said.some((m) => m.includes("not yet"))).toBe(true);
    expect(said.some((m) => m.includes("Setup complete"))).toBe(true);
  });
});
