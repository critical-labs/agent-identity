#!/usr/bin/env -S npx tsx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveFleetKey } from "@agent-identity/client";
import { ClaimManager } from "./claim-manager.js";
import { makeTools } from "./tools.js";

const requiredCaps = (process.env.AGENT_IDENTITY_REQUIRE ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const manager = new ClaimManager({
  apiUrl: process.env.AGENT_IDENTITY_API_URL!,
  fleetKey: resolveFleetKey(),
  require: requiredCaps,
});
await manager.init();

process.on("exit", () => manager.release());
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => process.exit(0));
}

const tools = makeTools(manager);
const server = new McpServer({ name: "agent-identity", version: "0.1.0" });
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

server.registerTool(
  "ensure_identity",
  {
    description: "Claim/confirm this session's identity and mailbox address. Idempotent; call at session start. Pass require:[\"github\"] to swap to a GitHub-capable identity.",
    inputSchema: { require: z.array(z.string()).optional() },
  },
  async (args) => json(await tools.ensureIdentity(args)),
);

server.registerTool(
  "identity_status",
  {
    description: "Show the identity this session holds, its capabilities, and pool availability.",
    inputSchema: {},
  },
  async () => json(tools.identityStatus()),
);

server.registerTool(
  "list_emails",
  {
    description: "List received emails, newest first.",
    inputSchema: { since: z.string().optional(), limit: z.number().int().max(50).optional() },
  },
  async (args) => json(await tools.listEmails(args)),
);

server.registerTool(
  "get_email",
  {
    description: "Get a full email by id, including body text and extracted links.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => json(await tools.getEmail(id)),
);

server.registerTool(
  "wait_for_email",
  {
    description: "Poll until an email matching the filters arrives, or timeout (returns {timedOut:true}).",
    inputSchema: {
      fromContains: z.string().optional(),
      subjectContains: z.string().optional(),
      timeoutSeconds: z.number().max(300).default(120),
    },
  },
  async (args) => json(await tools.waitForEmail(args)),
);

server.registerTool(
  "forge_repo",
  {
    description: "Get a repo's default branch and head sha via the forge proxy (service defaults to github).",
    inputSchema: {
      service: z.string().optional(),
      owner: z.string(),
      repo: z.string(),
    },
  },
  async (args) => json(await tools.forgeRepo(args)),
);

server.registerTool(
  "forge_commit",
  {
    description: "Create a commit on a branch via the forge proxy. Authorship is set server-side to this session's identity; the request carries no author.",
    inputSchema: {
      service: z.string().optional(),
      owner: z.string(),
      repo: z.string(),
      branch: z.string(),
      message: z.string(),
      files: z.array(z.object({ path: z.string(), content: z.string() })),
    },
  },
  async (args) => json(await tools.forgeCommit(args)),
);

server.registerTool(
  "forge_open_pr",
  {
    description: "Open a pull/merge request via the forge proxy. An attribution footer naming this identity is appended.",
    inputSchema: {
      service: z.string().optional(),
      owner: z.string(),
      repo: z.string(),
      head: z.string(),
      base: z.string(),
      title: z.string(),
      body: z.string(),
    },
  },
  async (args) => json(await tools.forgeOpenPr(args)),
);

server.registerTool(
  "forge_comment",
  {
    description: "Comment on an issue via the forge proxy. An attribution footer naming this identity is appended.",
    inputSchema: {
      service: z.string().optional(),
      owner: z.string(),
      repo: z.string(),
      issue: z.number().int(),
      body: z.string(),
    },
  },
  async (args) => json(await tools.forgeComment(args)),
);

server.registerTool(
  "forge_provision",
  {
    description: "Provision this session's identity on a forge that supports it (default gitlab): creates a service account whose email is this identity's mailbox, then watch for the confirmation email with wait_for_email.",
    inputSchema: { service: z.string().optional() },
  },
  async (args) => json(await tools.forgeProvision(args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
