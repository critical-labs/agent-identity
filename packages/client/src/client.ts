import {
  canonicalString, sign, type ActivityEvent, type AgentIdentity, type AgentStatusState,
  type AgentStatusView, type BlobResult, type CommentResult, type CommitChangesSpec,
  type CommitResult, type CommitSpec, type EmailFull, type EmailSummary, type ForgeProvisionResult,
  type ForkResult, type Keypair, type PrResult, type PrSpec,
  type RegisterResponse, type RepoInfo, type RepoRef, type SyncResult,
} from "@agent-identity/shared";

/** GET /me: identity plus operator-set capabilities and, when one has been
 *  recorded, the agent's own claimed status with server-computed freshness. */
export interface MeResponse extends AgentIdentity {
  capabilities?: string[];
  status?: AgentStatusView;
}

export interface ClientOptions {
  apiUrl: string;
  keypair: Keypair;
  fleetKey?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

// 429 retry policy: throttling is default and the bucket is shared across
// agents, so brief bursts are expected. Max 2 retries keeps worst-case
// latency bounded; Retry-After (seconds, capped) wins over the jittered
// backoff when the server sends it.
const MAX_RETRIES_429 = 2;

export class AgentIdentityClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request<T>(method: string, pathWithQuery: string, body = "", extra: Record<string, string> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // Sign inside the loop: each attempt needs a fresh timestamp to pass
      // the server's signature-freshness check.
      const timestamp = new Date().toISOString();
      const signature = sign(
        canonicalString(method, pathWithQuery, timestamp, body),
        this.opts.keypair.privateKeyPem,
      );
      const res = await this.fetchFn(`${this.opts.apiUrl}${pathWithQuery}`, {
        method,
        body: body || undefined,
        headers: {
          "x-agent-key": this.opts.keypair.publicKeySpkiBase64,
          "x-agent-timestamp": timestamp,
          "x-agent-signature": signature,
          ...(body ? { "content-type": "application/json" } : {}),
          ...extra,
        },
      });
      if (res.status === 429 && attempt < MAX_RETRIES_429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs = retryAfter > 0
          ? Math.min(retryAfter, 30) * 1000
          : 500 * (attempt + 1) + Math.random() * 250;
        // Drain the discarded response so the underlying socket is released to
        // the pool instead of left pinned by an unconsumed body stream (undici
        // holds the connection until the body is read or cancelled).
        await res.body?.cancel().catch(() => {});
        await this.sleep(delayMs);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
      return JSON.parse(text) as T;
    }
  }

  /** Register (idempotent). `requestedCapabilities` asks the deployment's
   *  AUTO_CAPABILITIES policy for birth grants; slugs outside the policy are
   *  silently ignored server-side. With no request the wire shape is
   *  unchanged (empty body), so older servers are unaffected. */
  register(opts: { requestedCapabilities?: string[] } = {}): Promise<RegisterResponse> {
    const body = opts.requestedCapabilities && opts.requestedCapabilities.length > 0
      ? JSON.stringify({ requestedCapabilities: opts.requestedCapabilities })
      : "";
    return this.request("POST", "/register", body,
      this.opts.fleetKey ? { "x-fleet-key": this.opts.fleetKey } : {});
  }

  me(): Promise<MeResponse> {
    return this.request("GET", "/me");
  }

  /** CLAIMED self-report: sets this agent's public status. The server stores
   *  it as class "claimed" — it is never presented as attested. */
  setStatus(state: AgentStatusState, label?: string): Promise<{ event: ActivityEvent }> {
    return this.request("POST", "/activity",
      JSON.stringify({ type: "status", state, ...(label !== undefined ? { label } : {}) }));
  }

  /** CLAIMED self-report: appends a short public task note to the ledger. */
  reportTaskNote(note: string): Promise<{ event: ActivityEvent }> {
    return this.request("POST", "/activity", JSON.stringify({ type: "task_note", note }));
  }

  myActivity(opts: { limit?: number; cursor?: string } = {}):
    Promise<{ events: ActivityEvent[]; cursor?: string }> {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return this.request("GET", `/agents/me/activity${qs ? `?${qs}` : ""}`);
  }

  listEmails(opts: {
    since?: string; limit?: number; cursor?: string;
    includeUnsolicited?: boolean; includeUnauthenticated?: boolean;
  } = {}): Promise<{ emails: EmailSummary[]; cursor?: string }> {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", opts.since);
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.includeUnsolicited) q.set("includeUnsolicited", "true");
    if (opts.includeUnauthenticated) q.set("includeUnauthenticated", "true");
    const qs = q.toString();
    return this.request("GET", `/emails${qs ? `?${qs}` : ""}`);
  }

  getEmail(id: string): Promise<EmailFull> {
    return this.request("GET", `/emails/${id}`);
  }

  forgeRepo(service: string, ref: RepoRef): Promise<RepoInfo> {
    return this.request("GET", `/forge/${service}/repo/${ref.owner}/${ref.name}`);
  }

  forgeCommit(service: string, ref: RepoRef, spec: CommitSpec): Promise<CommitResult> {
    return this.request("POST", `/forge/${service}/commit`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, ...spec }));
  }

  /** Upload one file's bytes as a blob (#118). Streaming path: one call per
   *  file, so no single request carries the whole change. */
  forgePutBlob(service: string, ref: RepoRef, contentBase64: string): Promise<BlobResult> {
    return this.request("POST", `/forge/${service}/blob`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, contentBase64 }));
  }

  /** Size-agnostic commit (#118) over a set of changes (blob shas, inline
   *  content, or deletions). Authorship is forced server-side. */
  forgeCommitChanges(service: string, ref: RepoRef, spec: CommitChangesSpec): Promise<CommitResult> {
    return this.request("POST", `/forge/${service}/commit-changes`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, ...spec }));
  }

  forgeOpenPr(service: string, ref: RepoRef, spec: PrSpec): Promise<PrResult> {
    return this.request("POST", `/forge/${service}/pr`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, ...spec }));
  }

  forgeComment(service: string, ref: RepoRef, issue: number, body: string): Promise<CommentResult> {
    return this.request("POST", `/forge/${service}/comment`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, issue, body }));
  }

  forgeFork(service: string, ref: RepoRef): Promise<ForkResult> {
    return this.request("POST", `/forge/${service}/fork`,
      JSON.stringify({ owner: ref.owner, repo: ref.name }));
  }

  /** Fast-forward a branch of the agent's FORK to its upstream, with the
   *  proxy's own credential. `ref` names the fork; `branch` omitted means the
   *  fork's default branch (the proxy resolves it). The proxy never creates a
   *  commit here: a 409 `fork_diverged` means the fork branch is ahead of
   *  upstream by any commit, conflicting or not, and was refused before the
   *  forge was asked — start a new branch instead. mergeType in the result is
   *  "fast-forward" (moved) or "none" (already level). */
  forgeSync(service: string, ref: RepoRef, branch?: string): Promise<SyncResult> {
    return this.request("POST", `/forge/${service}/sync`,
      JSON.stringify({ owner: ref.owner, repo: ref.name, ...(branch !== undefined ? { branch } : {}) }));
  }

  forgeProvision(service: string): Promise<ForgeProvisionResult> {
    return this.request("POST", `/forge/${service}/provision`);
  }
}
