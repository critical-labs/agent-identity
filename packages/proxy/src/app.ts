import {
  signatureAuth, type AgentRecord, type AgentsRepo, type NoncesRepo,
} from "@agent-identity/api";
import {
  sanitizeAttestedEvent,
  type ActivityEvent, type CommitChange, type RepoRef, type RepoVisibility,
} from "@agent-identity/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  ForgeError, statusFor, type Author, type Forge, type Provisioner,
} from "./forge.js";
import { evaluate, type ForgeOp, type Policy } from "./policy.js";

/** Attested-event sink (the shared data layer's ActivityRepo in production).
 *  The proxy is infrastructure: it observed the forge operation succeed, so
 *  it — and only it — may write these events as class "attested". */
export interface ActivityLedger {
  putEvent(event: ActivityEvent): Promise<unknown>;
}

/** What a route contributes to the attested event; agentId/ts/class are
 *  filled in centrally so no route can mislabel an event's class. */
type Attestation = Pick<ActivityEvent, "type" | "summary" | "detail" | "ref">;

export interface ProxyDeps {
  agents: AgentsRepo;
  nonces: NoncesRepo;
  forges: Record<string, Forge>;
  provisioners?: Record<string, Provisioner>;
  policy?: Policy;
  audit?: (line: Record<string, unknown>) => void;
  activity?: ActivityLedger;
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
    const agent = c.get("agent") as AgentRecord;
    const service = c.req.param("service");
    const forge = service ? deps.forges[service] : undefined;
    if (!service || !forge) {
      audit({ agentId: agent.agentId, service: service ?? "-", outcome: "rejected", reason: "unknown_service" });
      return c.json({ error: "unknown_service" }, 404);
    }
    if (!(agent.capabilities ?? []).includes(service)) {
      audit({ agentId: agent.agentId, service, outcome: "rejected", reason: "missing_capability" });
      return c.json({
        error: "missing_capability",
        remediation: `ask the operator to run: mailctl agent tag ${agent.agentId} ${service}`,
      }, 403);
    }
    return { service, forge, agent, actor: { name: agent.agentId, email: agent.address } };
  };

  // Fail-closed visibility stamp for attested forge events. The public
  // fleet tier publishes a forge event ONLY when detail.visibility is the
  // exact string "public" (shared/public-fleet.ts): a name allowlist alone
  // cannot know a repo's actual visibility, so the proxy — which holds a
  // live forge credential — asks the forge at attestation time. "public"
  // is stamped only when EVERY named repo reads public; a failed lookup
  // stamps nothing, which keeps the event out of the public tier while
  // preserving it in the keyed ledger.
  const visibilityStamp = async (
    g: Guarded, refs: RepoRef[],
  ): Promise<{ visibility?: RepoVisibility }> => {
    try {
      const all = await Promise.all(refs.map((r) => g.forge.repoVisibility(r, g.actor)));
      return { visibility: all.every((v) => v === "public") ? "public" : "private" };
    } catch {
      return {};
    }
  };

  // `okFields` lets a route add to the success audit line what `op` alone
  // cannot name — a value resolved inside the gated call (a defaulted
  // branch) or an outcome the operator must be able to grep for (a sync's
  // mergeType). The attested event carries these too, but the audit log is
  // what exists when no ledger is configured.
  const run = async <T>(
    c: Context, g: Guarded, op: ForgeOp, call: () => Promise<T>,
    attest?: (result: T) => Attestation | Promise<Attestation>,
    okFields?: (result: T) => Record<string, unknown>,
  ): Promise<Response> => {
    const base = {
      agentId: g.agent.agentId, service: op.service, op: op.kind,
      owner: op.owner, repo: op.repo,
    };
    const decision = (deps.policy ?? evaluate)(g.agent, op);
    if (!decision.allow) {
      audit({ ...base, outcome: "denied", reason: decision.reason });
      return c.json({ error: "denied", reason: decision.reason }, 403);
    }
    const started = Date.now();
    try {
      const result = await call();
      // `base` is spread LAST: a route's extra fields may add to the line but
      // never relabel who did what (agentId, service, op, owner, repo).
      audit({ ...okFields?.(result), ...base, outcome: "ok", latencyMs: Date.now() - started });
      if (attest && deps.activity) {
        try {
          // Central character/length defense: route attestations embed
          // request strings (branch, repo) that forges accept with arbitrary
          // non-ASCII and unbounded length. Sanitizing here — not per route —
          // means no route can forget it.
          await deps.activity.putEvent(sanitizeAttestedEvent({
            agentId: g.agent.agentId, ts: new Date().toISOString(),
            class: "attested", ...(await attest(result)),
          }));
        } catch (ledgerErr) {
          // The forge operation already succeeded; a ledger outage must
          // never turn that success into a failure. Log and continue.
          audit({
            ...base, outcome: "ledger_write_failed",
            error: (ledgerErr as Error).message,
          });
        }
      }
      return c.json(result as object);
    } catch (err) {
      if (err instanceof ForgeError) {
        audit({
          ...base, outcome: "error", errorKind: err.kind,
          upstreamStatus: err.upstream, latencyMs: Date.now() - started,
        });
        const label = err.kind === "upstream_auth" ? "upstream_credential_invalid" : err.kind;
        // provision runs with the group-owner admin token; its upstream error
        // text is admin-context, so don't echo it to the calling agent.
        const payload = op.kind === "provision"
          ? { error: label }
          : { error: label, detail: err.message };
        return c.json(payload, statusFor(err.kind) as never);
      }
      // Never silently swallow an unexpected failure in a credential proxy.
      audit({ ...base, outcome: "unexpected", latencyMs: Date.now() - started });
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

  const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  // owner/repo/branch are interpolated into upstream URL paths by adapters,
  // where fetch's WHATWG URL normalization turns ".." into an escape from the
  // policy-pinned fork repo — so names must be single path segments and a
  // branch may contain "/" but never dot segments, "..", "\", or controls.
  const isName = (v: unknown): v is string =>
    isStr(v) && /^[A-Za-z0-9_.-]+$/.test(v) && !/^\.+$/.test(v);
  const isBranch = (v: unknown): v is string =>
    isStr(v) && !v.includes("..") && !/[\\\u0000-\u001f\u007f]/.test(v) &&
    v.split("/").every((s) => s.length > 0 && s !== ".");
  const isFiles = (v: unknown): v is { path: string; content: string }[] =>
    Array.isArray(v) && v.length > 0 &&
    v.every((f) => isStr((f as { path?: unknown }).path) &&
      typeof (f as { content?: unknown }).content === "string");
  // A change is A/M (a pre-uploaded blobSha OR inline content) or a deletion.
  // File paths ride in the JSON body (tree entries / gitlab actions), never a
  // URL path, so the #94 owner/repo/branch URL hardening does not apply to
  // them; each need only be a non-empty string.
  const isChanges = (v: unknown): boolean =>
    Array.isArray(v) && v.length > 0 &&
    v.every((c) => {
      const o = c as Record<string, unknown>;
      if (!isStr(o.path)) return false;
      if (o.deleted === true) return true;
      if (typeof o.blobSha === "string" && o.blobSha.length > 0) return true;
      return typeof o.content === "string";
    });

  app.post("/forge/:service/commit", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isName(b.owner) || !isName(b.repo) || !isBranch(b.branch)
      || !isStr(b.message) || !isFiles(b.files)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "commit", owner: b.owner, repo: b.repo };
    const repo = `${b.owner}/${b.repo}`;
    return run(c, g, op, () => g.forge.createCommit(
      { owner: b.owner as string, name: b.repo as string },
      {
        branch: b.branch as string, message: b.message as string,
        files: b.files as { path: string; content: string }[],
      },
      g.actor,
    ), async (r) => ({
      type: "forge_commit",
      summary: `committed to ${repo}@${b.branch}`,
      detail: {
        service: g.service, repo, branch: b.branch as string, sha: r.sha,
        ...(await visibilityStamp(g, [{ owner: b.owner as string, name: b.repo as string }])),
      },
      ref: r.url,
    }));
  });

  // Streaming blob upload (#118), the first write of the size-agnostic commit
  // path. Same signature auth + capability guard as every forge route, and —
  // crucially — the SAME policy gate: op.kind "blob" is fork-namespace-pinned
  // (see policy.ts), so a rejected target creates NOTHING, blobs included.
  app.post("/forge/:service/blob", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isName(b.owner) || !isName(b.repo) || !isStr(b.contentBase64)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "blob", owner: b.owner, repo: b.repo };
    return run(c, g, op, () => g.forge.putBlob(
      { owner: b.owner as string, name: b.repo as string },
      { contentBase64: b.contentBase64 as string },
      g.actor,
    ));
  });

  // Size-agnostic commit (#118): a set of changes (blob shas, inline content,
  // or deletions) rather than whole-file inline content. Same validation and
  // attestation as /commit; the fork-namespace pin (op.kind "commit") gates it
  // BEFORE any write.
  app.post("/forge/:service/commit-changes", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isName(b.owner) || !isName(b.repo) || !isBranch(b.branch)
      || !isStr(b.message) || !isChanges(b.changes)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "commit", owner: b.owner, repo: b.repo };
    const repo = `${b.owner}/${b.repo}`;
    return run(c, g, op, () => g.forge.commitChanges(
      { owner: b.owner as string, name: b.repo as string },
      {
        branch: b.branch as string, message: b.message as string,
        changes: b.changes as CommitChange[],
      },
      g.actor,
    ), async (r) => ({
      type: "forge_commit",
      summary: `committed to ${repo}@${b.branch}`,
      detail: {
        service: g.service, repo, branch: b.branch as string, sha: r.sha,
        ...(await visibilityStamp(g, [{ owner: b.owner as string, name: b.repo as string }])),
      },
      ref: r.url,
    }));
  });

  app.post("/forge/:service/pr", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo) || !isStr(b.head)
      || !isStr(b.base) || !isStr(b.title) || typeof b.body !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "pr", owner: b.owner, repo: b.repo };
    const footer = `\n\n_opened by agent ${g.agent.agentId} via agent-identity proxy_`;
    const repo = `${b.owner}/${b.repo}`;
    return run(c, g, op, () => g.forge.openPullRequest(
      { owner: b.owner as string, name: b.repo as string },
      {
        head: b.head as string, base: b.base as string,
        title: b.title as string, body: `${b.body}${footer}`,
      },
      g.actor,
    ), async (r) => ({
      type: "forge_pr",
      summary: `opened PR #${r.number} on ${repo}`,
      detail: {
        service: g.service, repo, number: r.number,
        ...(await visibilityStamp(g, [{ owner: b.owner as string, name: b.repo as string }])),
      },
      ref: r.url,
    }));
  });

  app.post("/forge/:service/comment", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo)
      || !Number.isInteger(b.issue) || typeof b.body !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "comment", owner: b.owner, repo: b.repo };
    const footer = `\n\n_comment by agent ${g.agent.agentId} via agent-identity proxy_`;
    const repo = `${b.owner}/${b.repo}`;
    return run(c, g, op, () => g.forge.comment(
      { owner: b.owner as string, name: b.repo as string },
      b.issue as number, `${b.body}${footer}`, g.actor,
    ), async (r) => ({
      type: "forge_comment",
      summary: `commented on ${repo}#${b.issue}`,
      detail: {
        service: g.service, repo, issue: b.issue as number,
        ...(await visibilityStamp(g, [{ owner: b.owner as string, name: b.repo as string }])),
      },
      ref: r.url,
    }));
  });

  app.post("/forge/:service/fork", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isStr(b.owner) || !isStr(b.repo)) return c.json({ error: "invalid_request" }, 400);
    const op: ForgeOp = { service: g.service, kind: "fork", owner: b.owner, repo: b.repo };
    const source = `${b.owner}/${b.repo}`;
    return run(c, g, op,
      () => g.forge.fork({ owner: b.owner as string, name: b.repo as string }, g.actor),
      async (r) => ({
        type: "forge_fork",
        summary: `forked ${source} to ${r.owner}/${r.repo}`,
        detail: {
          service: g.service, source, fork: `${r.owner}/${r.repo}`,
          // A fork event names TWO repos; it is public only when both are.
          ...(await visibilityStamp(g, [
            { owner: b.owner as string, name: b.repo as string },
            { owner: r.owner, name: r.repo },
          ])),
        },
      }));
  });

  // Sync a fork branch from its upstream. `owner`/`repo` name the FORK: the
  // op is a ref write to that repo, so it is fork-namespace-pinned (op.kind
  // "sync", see policy.ts) and a sync aimed at the source is refused before
  // the adapter is reached. `branch` is optional and defaults to the fork's
  // default branch, resolved here rather than required of the caller: the
  // default is one more upstream read, and resolving it inside the gated
  // call keeps the resolution behind the same policy decision, so a denied
  // target gets no read either. Doing it in the proxy — not the MCP tool —
  // means every client (MCP, raw SDK) gets the same default without a
  // second signed round trip. (getRepo also reads the head sha, which a
  // default needs not; one spare read per defaulted sync is cheaper than a
  // second repo-read method on every adapter.) The success audit line names
  // the branch actually moved and the mergeType the forge reported, because
  // `op` alone cannot carry a defaulted branch, and a "merge" — the trace of
  // a bot-authored merge commit the adapter's pre-check failed to prevent —
  // must be greppable in the log, not only in the ledger.
  app.post("/forge/:service/sync", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const b = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!b || !isName(b.owner) || !isName(b.repo)
      || (b.branch !== undefined && !isBranch(b.branch))) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const op: ForgeOp = { service: g.service, kind: "sync", owner: b.owner, repo: b.repo };
    const ref: RepoRef = { owner: b.owner, name: b.repo };
    const fork = `${b.owner}/${b.repo}`;
    let branch = b.branch as string | undefined;
    return run(c, g, op, async () => {
      branch ??= (await g.forge.getRepo(ref, g.actor)).defaultBranch;
      return g.forge.syncFork(ref, branch, g.actor);
    }, async (r) => ({
      type: "forge_sync",
      summary: `synced ${fork}@${branch} from upstream (${r.mergeType})`,
      detail: {
        service: g.service, fork, branch: branch as string, mergeType: r.mergeType,
        // A sync names ONE repo, the fork; the upstream is not a party to
        // the event (the forge chose it), so only the fork's visibility
        // decides whether the event may be public.
        ...(await visibilityStamp(g, [ref])),
      },
    }), (r) => ({ branch, mergeType: r.mergeType }));
  });

  app.post("/forge/:service/provision", async (c) => {
    const g = guard(c);
    if (g instanceof Response) return g;
    const provisioner = deps.provisioners?.[g.service];
    if (!provisioner) return c.json({ error: "provisioning_unsupported" }, 404);
    const op: ForgeOp = { service: g.service, kind: "provision", owner: "-", repo: "-" };
    // The event deliberately records only the service: the provisioned
    // username and mailbox address must never reach fleet feeds.
    return run(c, g, op, () => provisioner.provision(g.actor), () => ({
      type: "capability_granted",
      summary: `provisioned a ${g.service} service account`,
      detail: { service: g.service },
    }));
  });

  return app;
}
