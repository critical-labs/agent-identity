import {
  signatureAuth, type AgentRecord, type AgentsRepo, type NoncesRepo,
} from "@agent-identity/api";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  ForgeError, statusFor, type Author, type Forge, type Provisioner,
} from "./forge.js";
import { evaluate, type ForgeOp } from "./policy.js";

export interface ProxyDeps {
  agents: AgentsRepo;
  nonces: NoncesRepo;
  forges: Record<string, Forge>;
  provisioners?: Record<string, Provisioner>;
  audit?: (line: Record<string, unknown>) => void;
}

interface Guarded {
  service: string;
  forge: Forge;
  agent: AgentRecord;
  actor: Author;
}

export function createProxyApp(deps: ProxyDeps): Hono {
  const app = new Hono();
  const audit = deps.audit ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  app.use("*", signatureAuth(deps.agents, deps.nonces));

  const guard = (c: Context): Guarded | Response => {
    const service = c.req.param("service");
    const forge = deps.forges[service];
    if (!forge) return c.json({ error: "unknown_service" }, 404);
    const agent = c.get("agent") as AgentRecord;
    if (!(agent.capabilities ?? []).includes(service)) {
      return c.json({
        error: "missing_capability",
        remediation: `ask the operator to run: mailctl agent tag ${agent.agentId} ${service}`,
      }, 403);
    }
    return { service, forge, agent, actor: { name: agent.agentId, email: agent.address } };
  };

  const run = async <T>(
    c: Context, g: Guarded, op: ForgeOp, call: () => Promise<T>,
  ): Promise<Response> => {
    const decision = evaluate(g.agent, op);
    if (!decision.allow) return c.json({ error: "denied", reason: decision.reason }, 403);
    const started = Date.now();
    const base = {
      agentId: g.agent.agentId, service: op.service, op: op.kind,
      owner: op.owner, repo: op.repo,
    };
    try {
      const result = await call();
      audit({ ...base, outcome: "ok", latencyMs: Date.now() - started });
      return c.json(result as object);
    } catch (err) {
      if (err instanceof ForgeError) {
        audit({
          ...base, outcome: "error", errorKind: err.kind,
          upstreamStatus: err.upstream, latencyMs: Date.now() - started,
        });
        const label = err.kind === "upstream_auth" ? "upstream_credential_invalid" : err.kind;
        return c.json({ error: label, detail: err.message }, statusFor(err.kind) as never);
      }
      throw err;
    }
  };

  app.get("/forge/:service/repo/:owner/:repo", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const { owner, repo } = c.req.param();
    const op: ForgeOp = { service: g.service, kind: "repo", owner, repo };
    return run(c, g, op, () => g.forge.getRepo({ owner, name: repo }, g.actor));
  });

  return app;
}
