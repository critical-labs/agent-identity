#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { linkGithub, poolStatus } from "./claims.js";
import { readMachineConfig, resolveFleetKey } from "./config.js";
import { provisionIdentities } from "./provision.js";
import { runSetup } from "./wizard.js";

const program = new Command("agent-identity");

const fail = (message: string): void => {
  console.error(`error: ${message}`);
  process.exitCode = 1;
};

program
  .command("setup")
  .description("interactive onboarding for a consuming repo: backend, identities, .mcp.json, skill")
  .option("--skill-dir <dir>", "override the bundled skill directory (dev checkouts)")
  .action(async (opts: { skillDir?: string }) => {
    const rl = readline.createInterface({ input, output });
    try {
      await runSetup({
        io: { ask: (q) => rl.question(q), say: (m) => console.log(m) },
        cwd: process.cwd(),
        skillDir: opts.skillDir
          ?? join(dirname(fileURLToPath(import.meta.url)), "..", "skill"),
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      rl.close();
    }
  });

const pool = program.command("pool").description("identity pool operations");

pool
  .command("provision")
  .description("mint identities into the machine-local pool")
  .requiredOption("--count <n>", "how many identities to mint")
  .option("--api-url <url>", "API base URL (default: machine config)")
  .option("--fleet-key <key>", "fleet key (default: env, then ~/.config/agent-identity/fleet_key)")
  .action(async (opts: { count: string; apiUrl?: string; fleetKey?: string }) => {
    const apiUrl = opts.apiUrl ?? readMachineConfig().apiUrl ?? process.env.AGENT_IDENTITY_API_URL;
    const fleetKey = opts.fleetKey ?? resolveFleetKey();
    if (!apiUrl) return fail("no API URL (pass --api-url or run: agent-identity setup)");
    if (!fleetKey) return fail("no fleet key (pass --fleet-key or run: agent-identity setup)");
    const count = Number.parseInt(opts.count, 10);
    if (!Number.isInteger(count) || count < 1) return fail("--count must be a positive integer");
    const results = await provisionIdentities({ count, apiUrl, fleetKey });
    for (const r of results) {
      console.log(r.error ? `failed: ${r.error}` : `minted ${r.agentId} <${r.address}>`);
    }
    const succeeded = results.filter((r) => !r.error).length;
    console.log(`${succeeded}/${count} identities provisioned`);
    if (succeeded === 0) process.exitCode = 1;
  });

pool
  .command("status")
  .description("show pool totals and free identities by capability")
  .action(() => {
    const s = poolStatus();
    console.log(`total: ${s.total}  free: ${s.free}`);
    for (const [cap, n] of Object.entries(s.freeByCapability)) {
      console.log(`free with ${cap}: ${n}`);
    }
  });

const github = program.command("github").description("GitHub account linkage");

github
  .command("link <agentId>")
  .description("record that this pool identity has a GitHub account")
  .requiredOption("--username <login>", "GitHub login of the account")
  .option("--credential-ref <ref>", "credential reference (e.g. op://...), never a raw secret")
  .action((agentId: string, opts: { username: string; credentialRef?: string }) => {
    try {
      linkGithub(agentId, {
        username: opts.username,
        ...(opts.credentialRef ? { credentialRef: opts.credentialRef } : {}),
      });
      console.log(`linked ${agentId} -> github:${opts.username}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

await program.parseAsync();
