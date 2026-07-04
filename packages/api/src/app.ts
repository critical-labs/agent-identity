import { fingerprint } from "@agent-identity/shared";
import { Hono } from "hono";
import { signatureAuth } from "./auth.js";
import type { AgentsRepo } from "./db/agents.js";
import type { EmailsRepo } from "./db/emails.js";

export interface Deps {
  agents: AgentsRepo;
  emails: EmailsRepo;
  readBody: (s3Key: string) => Promise<{ text: string; html?: string; links: string[] }>;
  fleetKeyRequired: boolean;
}

export function createApp(deps: Deps): Hono {
  const app = new Hono();
  app.use("*", signatureAuth(deps.agents));

  app.post("/register", async (c) => {
    if (deps.fleetKeyRequired) {
      const fleetKey = c.req.header("x-fleet-key");
      if (!fleetKey || !(await deps.agents.verifyFleetKey(fleetKey)))
        return c.json({ error: "invalid fleet key" }, 403);
    }
    const publicKey = c.get("verifiedPublicKey");
    const identity = await deps.agents.register(publicKey, fingerprint(publicKey));
    return c.json(identity);
  });

  app.get("/me", (c) => {
    const { agentId, address } = c.get("agent");
    return c.json({ agentId, address });
  });

  app.get("/emails", async (c) => {
    const limitRaw = c.req.query("limit");
    const result = await deps.emails.listEmails(c.get("agent").agentId, {
      since: c.req.query("since"),
      limit: limitRaw ? Number(limitRaw) : undefined,
      cursor: c.req.query("cursor"),
    });
    return c.json(result);
  });

  app.get("/emails/:id", async (c) => {
    const email = await deps.emails.getEmail(c.get("agent").agentId, c.req.param("id"));
    if (!email) return c.json({ error: "not found" }, 404);
    const { bodyS3Key, ...rest } = email;
    if (bodyS3Key) {
      const body = await deps.readBody(bodyS3Key);
      return c.json({ ...rest, ...body });
    }
    return c.json(rest);
  });

  return app;
}
