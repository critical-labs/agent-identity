import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultChecklistDeps, deployChecklist, type ChecklistDeps,
} from "./checklist.js";
import {
  readFleetKeyFile, readMachineConfig, writeFleetKeyFile, writeMachineConfig,
} from "./config.js";
import { provisionIdentities } from "./provision.js";
import {
  installSkill, mergeMcpJson, skillDest, validateApiUrl, type FetchLike,
} from "./setup.js";

export interface SetupIO {
  ask(question: string): Promise<string>;
  say(message: string): void;
}

export interface SetupDeps {
  io: SetupIO;
  cwd: string;                 // consuming repo root (where .mcp.json lives)
  skillDir: string;            // bundled skill source directory
  base?: string;               // config dir override (tests)
  fetchFn?: FetchLike;
  checklistDeps?: ChecklistDeps;
  provision?: typeof provisionIdentities;
}

export async function runSetup(deps: SetupDeps): Promise<void> {
  const { io } = deps;
  io.say("agent-identity setup");

  // 1. Backend
  let backend = "";
  while (backend !== "1" && backend !== "2") {
    backend = (await io.ask(
      "Backend: [1] connect to an existing deployment  [2] deploy a new one [1]: ",
    )).trim() || "1";
  }

  // 2. Deploy-new guided checklist
  if (backend === "2") {
    const domain = (await io.ask("Mail domain for the new deployment (e.g. mail.example.com): ")).trim();
    const cds = deps.checklistDeps ?? defaultChecklistDeps();
    for (const step of deployChecklist()) {
      io.say(`\n== ${step.title}\n${step.instructions}`);
      if (!step.verify) {
        await io.ask("Press enter to continue: ");
        continue;
      }
      for (;;) {
        await io.ask("Press enter once done (I'll verify): ");
        const err = await step.verify(cds, { domain });
        if (!err) {
          io.say("verified");
          break;
        }
        io.say(`not verified: ${err}`);
      }
    }
  }

  // 3. API URL (validated)
  const config = readMachineConfig(deps.base);
  let apiUrl = "";
  for (;;) {
    apiUrl = (await io.ask(
      `API URL${config.apiUrl ? ` [${config.apiUrl}]` : ""}: `,
    )).trim() || config.apiUrl || "";
    if (!apiUrl) continue;
    const err = await validateApiUrl(apiUrl, deps.fetchFn);
    if (!err) break;
    io.say(err);
  }
  writeMachineConfig({ ...config, apiUrl }, deps.base);

  // 4. Fleet key
  let fleetKey = readFleetKeyFile(deps.base);
  const keyAnswer = (await io.ask(
    fleetKey ? "Fleet key [keep existing]: " : "Fleet key: ",
  )).trim();
  if (keyAnswer) {
    writeFleetKeyFile(keyAnswer, deps.base);
    fleetKey = keyAnswer;
  }

  // 5. Provision
  const countAnswer = (await io.ask("How many identities should I provision now? [0]: ")).trim();
  const count = Number.parseInt(countAnswer || "0", 10) || 0;
  if (count > 0) {
    if (!fleetKey) {
      io.say("no fleet key available; skipping provisioning");
    } else {
      const provision = deps.provision ?? provisionIdentities;
      const results = await provision({ count, apiUrl, fleetKey, base: deps.base });
      for (const r of results) {
        io.say(r.error ? `failed: ${r.error}` : `minted ${r.agentId} <${r.address}>`);
      }
      io.say(`${results.filter((r) => !r.error).length}/${count} identities provisioned`);
    }
  }

  // 6. Require github?
  const requireGithub = (await io.ask(
    "Require a GitHub-capable identity for this repo? [y/N]: ",
  )).trim().toLowerCase().startsWith("y");

  // 7. .mcp.json
  const mcpPath = join(deps.cwd, ".mcp.json");
  let existing: string | undefined;
  try {
    existing = readFileSync(mcpPath, "utf8");
  } catch {
    existing = undefined;
  }
  writeFileSync(mcpPath, mergeMcpJson(existing, { apiUrl, requireGithub }));
  io.say(`wrote ${mcpPath}`);

  // 8. Skill
  let install = true;
  if (existsSync(skillDest(deps.cwd))) {
    install = !(await io.ask("Skill already installed; overwrite? [Y/n]: "))
      .trim().toLowerCase().startsWith("n");
  }
  if (install) {
    try {
      io.say(`installed skill at ${installSkill(deps.skillDir, deps.cwd)}`);
    } catch (err) {
      io.say(`skill not installed: ${(err as Error).message}`);
    }
  }

  io.say("\nSetup complete. Restart your Claude session and call ensure_identity.");
}
