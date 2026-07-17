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

const transport = new StdioServerTransport();
await server.connect(transport);
