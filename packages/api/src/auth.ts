import { canonicalString, fingerprint, verify } from "@agent-identity/shared";
import type { MiddlewareHandler } from "hono";
import type { AgentRecord, AgentsRepo } from "./db/agents.js";

const SKEW_MS = 300_000;

declare module "hono" {
  interface ContextVariableMap {
    agent: AgentRecord;
    verifiedPublicKey: string;
  }
}

export function signatureAuth(agents: AgentsRepo): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header("x-agent-key");
    const ts = c.req.header("x-agent-timestamp");
    const sig = c.req.header("x-agent-signature");
    if (!key || !ts || !sig) return c.json({ error: "missing auth headers" }, 401);

    if (Math.abs(Date.now() - Date.parse(ts)) > SKEW_MS)
      return c.json({ error: "timestamp out of range" }, 401);

    const url = new URL(c.req.url);
    const pathWithQuery = url.pathname + url.search;
    const body = await c.req.raw.clone().text();
    const message = canonicalString(c.req.method, pathWithQuery, ts, body);
    if (!verify(message, sig, key)) return c.json({ error: "invalid signature" }, 401);

    c.set("verifiedPublicKey", key);

    // /register is the only route allowed before an agent record exists;
    // signature possession is proven above, fleet key is checked in the route.
    if (c.req.method === "POST" && url.pathname === "/register") return next();

    const agent = await agents.getByFingerprint(fingerprint(key));
    if (!agent) return c.json({ error: "unknown agent" }, 401);
    if (agent.status !== "active") return c.json({ error: "revoked" }, 403);
    c.set("agent", agent);
    return next();
  };
}
