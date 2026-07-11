#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import { linkGithub } from "./claims.js";

const program = new Command("agent-identity");

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
      const message = err instanceof Error ? err.message : String(err);
      console.error(`error: ${message}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
