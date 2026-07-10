import { canonicalString, fingerprint, verify } from "@agent-identity/shared";
import type { MiddlewareHandler } from "hono";
import type { AgentRecord, AgentsRepo } from "./db/agents.js";
import type { NoncesRepo } from "./db/nonces.js";

const SKEW_MS = 300_000;

declare module "hono" {
  interface ContextVariableMap {
    agent: AgentRecord;
    verifiedPublicKey: string;
  }
}

export function signatureAuth(agents: AgentsRepo, nonces: NoncesRepo): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header("x-agent-key");
    const ts = c.req.header("x-agent-timestamp");
    const sig = c.req.header("x-agent-signature");
    if (!key || !ts || !sig) return c.json({ error: "missing auth headers" }, 401);

    // NaN comparisons are false, so an unparseable timestamp must be
    // rejected explicitly or it would bypass the replay window entirely.
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > SKEW_MS)
      return c.json({ error: "timestamp out of range" }, 401);

    const url = new URL(c.req.url);
    const pathWithQuery = url.pathname + url.search;
    const body = await c.req.raw.clone().text();
    const message = canonicalString(c.req.method, pathWithQuery, ts, body);
    if (!verify(message, sig, key)) return c.json({ error: "invalid signature" }, 401);

    // Compute fingerprint once; reused for nonce key and agent lookup.
    const fp = fingerprint(key);

    // Ed25519 is deterministic, so an identical legitimate request in the same
    // millisecond is indistinguishable from a replay; we reject both.
    if (!(await nonces.recordOnce(fp, sig))) return c.json({ error: "replayed request" }, 401);

    c.set("verifiedPublicKey", key);

    // /register is the only route allowed before an agent record exists;
    // signature possession is proven above, fleet key is checked in the route.
    if (c.req.method === "POST" && url.pathname === "/register") return next();

    const agent = await agents.getByFingerprint(fp);
    if (!agent) return c.json({ error: "unknown agent" }, 401);
    if (agent.status !== "active") return c.json({ error: "revoked" }, 403);
    c.set("agent", agent);
    return next();
  };
}
