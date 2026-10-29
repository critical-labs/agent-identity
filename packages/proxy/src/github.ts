import type {
  BlobResult, BlobSpec, CommentResult, CommitChangesSpec, CommitResult, CommitSpec,
  ForkResult, PrResult, PrSpec, RepoInfo, RepoRef,
  RepoVisibility, SyncResult,
} from "@agent-identity/shared";
import { canonicalCommitObject } from "./commit-object.js";
import {
  ForgeError, type Author, type CredentialStore, type Forge,
} from "./forge.js";

// merge-upstream's verdicts, as the proxy will repeat them in attested events
// and the public fleet projection: anything else the forge says is an error.
const MERGE_TYPES: ReadonlySet<string> = new Set(["fast-forward", "merge", "none"]);
function isMergeType(value: unknown): value is SyncResult["mergeType"] {
  return typeof value === "string" && MERGE_TYPES.has(value);
}

export interface GithubForgeOptions {
  credentials: CredentialStore;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  /** Clock for the signed commit's author/committer dates (issue #120),
   *  injectable for deterministic tests. */
  now?: () => number;
}

export class GithubForge implements Forge {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly base: string;
  private readonly now: () => number;

  constructor(private readonly opts: GithubForgeOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.base = opts.apiBase ?? "https://api.github.com";
    this.now = opts.now ?? Date.now;
  }

  /** `commit: true` selects the COMMIT write-path AUTH token (a GitHub App
   *  installation token when configured, #121; else the PAT); every other
   *  call uses the PAT via resolve(). This token only authorizes the write —
   *  the Verified signature is applied separately in commitTree via the
   *  SSH commit signer (#120). */
  private async gh<T>(
    method: string, path: string, agentId: string, body?: unknown, commit = false,
  ): Promise<T> {
    const token = commit
      ? await this.opts.credentials.resolveCommitToken("github", agentId)
      : await this.opts.credentials.resolve("github", agentId);
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await this.mapError(res);
    return res.json() as Promise<T>;
  }

  private async mapError(res: Response): Promise<ForgeError> {
    const text = await res.text();
    if (res.status === 401) return new ForgeError("upstream_auth", "github rejected the credential", 401);
    if (res.status === 404) return new ForgeError("not_found", "not found on github", 404);
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0"))
      return new ForgeError("rate_limited", "github rate limit exhausted", res.status);
    // A non-rate-limit 403 is a permission problem (missing scope / no repo
    // access), not a malformed request — keep it distinct from `invalid`.
    if (res.status === 403)
      return new ForgeError("forbidden", "github forbade the operation for this credential", 403);
    if (res.status === 422 && /fast forward/i.test(text))
      return new ForgeError("non_fast_forward", "ref update is not a fast forward", 422);
    return new ForgeError("invalid", `github ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  /** GitHub has no nested namespaces: owner and repo are each ONE path
   *  segment. Enforced here because ref values are interpolated into request
   *  paths, where fetch's WHATWG URL normalization would let a separator,
   *  dot segment, or "%" escape the policy-pinned fork repo. */
  private repoPath(ref: RepoRef): string {
    const segment = /^[A-Za-z0-9_.-]+$/;
    if (!segment.test(ref.owner) || !segment.test(ref.name)
      || /^\.+$/.test(ref.owner) || /^\.+$/.test(ref.name)) {
      throw new ForgeError("invalid", "owner and repo must each be a single path segment", 400);
    }
    return `/repos/${ref.owner}/${ref.name}`;
  }

  async getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo> {
    const r = this.repoPath(ref);
    const repo = await this.gh<{ default_branch: string }>("GET", r, actor.name);
    const head = await this.gh<{ object: { sha: string } }>(
      "GET", `${r}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`, actor.name);
    return { defaultBranch: repo.default_branch, headSha: head.object.sha };
  }

  /** Head sha of the branch, auto-creating it when missing (issue #93):
   *  the ref is created from THIS repo's default-branch head — never the
   *  source repo's — so a fresh fork needs no raw-PAT branch setup. Runs
   *  only inside createCommit, which the proxy policy-gates before any call. */
  private async resolveBranchHead(r: string, branch: string, agentId: string): Promise<string> {
    // Encoded so the branch stays ONE path unit: an unencoded branch would
    // let dot segments re-target the ref URLs outside `r` (fetch normalizes
    // them before the request leaves the process).
    const ref = `${r}/git/ref/heads/${encodeURIComponent(branch)}`;
    try {
      const head = await this.gh<{ object: { sha: string } }>("GET", ref, agentId, undefined, true);
      return head.object.sha;
    } catch (err) {
      if (!(err instanceof ForgeError && err.kind === "not_found")) throw err;
    }
    // An empty repo (fresh fork still importing) 404s here — the existing
    // retryable not_found, not a new error class.
    const repo = await this.gh<{ default_branch: string }>("GET", r, agentId, undefined, true);
    const def = await this.gh<{ object: { sha: string } }>(
      "GET", `${r}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`, agentId, undefined, true);
    try {
      await this.gh("POST", `${r}/git/refs`, agentId,
        { ref: `refs/heads/${branch}`, sha: def.object.sha }, true);
      return def.object.sha;
    } catch (err) {
      // The ref appeared between check and create — commit onto it as-is.
      if (err instanceof ForgeError && err.upstream === 422 && /already exists/i.test(err.message)) {
        const head = await this.gh<{ object: { sha: string } }>("GET", ref, agentId, undefined, true);
        return head.object.sha;
      }
      throw err;
    }
  }

  /** One tree entry as the git-data API expects it. An add/modify sets
   *  either `content` (inline UTF-8) or `sha` (a pre-uploaded blob); a
   *  deletion sets `sha: null`, which removes the path from the base tree. */
  private static entry(
    e: { path: string; content?: string; sha?: string | null },
  ): Record<string, unknown> {
    return { mode: "100644", type: "blob", ...e };
  }

  /** The single tree→commit→ref write path shared by createCommit (inline
   *  small path) and commitChanges (size-agnostic). CRITICAL: repoPath() has
   *  already validated owner/repo and the proxy has already run the
   *  fork-namespace policy + app-layer name/branch validation BEFORE this is
   *  reached — no blob/tree/commit/ref write happens for a rejected target. */
  private async commitTree(
    r: string, branch: string, message: string,
    entries: { path: string; content?: string; sha?: string | null }[],
    actor: Author,
  ): Promise<CommitResult> {
    // Resolve the signer FIRST: a partially-configured signer fails closed
    // (throws), and doing it before any upstream call guarantees a
    // misconfiguration creates NOTHING — no ref read, tree, commit, or ref
    // move. When signing is off this returns undefined (unsigned, as before).
    const signer = await this.opts.credentials.resolveCommitSigner("github", actor.name);

    const headSha = await this.resolveBranchHead(r, branch, actor.name);
    const baseCommit = await this.gh<{ tree: { sha: string } }>(
      "GET", `${r}/git/commits/${headSha}`, actor.name, undefined, true);
    const tree = await this.gh<{ sha: string }>("POST", `${r}/git/trees`, actor.name, {
      base_tree: baseCommit.tree.sha,
      tree: entries.map((e) => GithubForge.entry(e)),
    }, true);
    const parents = [headSha];
    const author: Author = { name: actor.name, email: actor.email };
    // Baseline (unsigned) body: author is the acting identity, committer is
    // left to the commit-path token's account. Unchanged when no signer is
    // configured.
    const body: Record<string, unknown> = { message, tree: tree.sha, parents, author };

    // When SSH commit signing is configured (issue #120), sign the canonical
    // commit object and stamp the committer (the signing bot, whose public key
    // is registered as a signing key on its account) so the forge reports the
    // commit verified. The author stays the acting identity — committer≠author
    // is the attribution model. One timestamp is captured for BOTH dates and
    // for the signed bytes, and the message is newline-terminated, so the
    // object the forge reconstructs from these fields is byte-identical to what
    // was signed (else the forge reports the signature invalid).
    if (signer) {
      const unixSec = Math.floor(this.now() / 1000);
      const dateUtc = `${new Date(unixSec * 1000).toISOString().slice(0, 19)}Z`;
      const message2 = message.endsWith("\n") ? message : `${message}\n`;
      const canonical = canonicalCommitObject({
        tree: tree.sha, parents, author, committer: signer.committer, message: message2, unixSec,
      });
      body.message = message2;
      body.author = { ...author, date: dateUtc };
      body.committer = { ...signer.committer, date: dateUtc };
      body.signature = signer.sign(canonical);
    }

    const commit = await this.gh<{ sha: string; html_url: string }>(
      "POST", `${r}/git/commits`, actor.name, body, true);
    await this.gh("PATCH", `${r}/git/refs/heads/${encodeURIComponent(branch)}`, actor.name,
      { sha: commit.sha, force: false }, true);
    return { sha: commit.sha, url: commit.html_url };
  }

  async createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult> {
    const r = this.repoPath(ref);
    return this.commitTree(r, spec.branch, spec.message,
      spec.files.map((f) => ({ path: f.path, content: f.content })), actor);
  }

  async putBlob(ref: RepoRef, spec: BlobSpec, actor: Author): Promise<BlobResult> {
    // repoPath() pins owner/repo to a single segment BEFORE the write — a
    // blob for an off-namespace target is refused by the proxy policy first,
    // and a malformed ref never leaves the process.
    const r = this.repoPath(ref);
    const blob = await this.gh<{ sha: string }>("POST", `${r}/git/blobs`, actor.name, {
      content: spec.contentBase64, encoding: "base64",
    }, true);
    return { sha: blob.sha };
  }

  async commitChanges(ref: RepoRef, spec: CommitChangesSpec, actor: Author): Promise<CommitResult> {
    const r = this.repoPath(ref);
    const entries = spec.changes.map((c) => {
      if ("deleted" in c) return { path: c.path, sha: null };
      if ("blobSha" in c) return { path: c.path, sha: c.blobSha };
      return { path: c.path, content: c.content };
    });
    return this.commitTree(r, spec.branch, spec.message, entries, actor);
  }

  async openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult> {
    const pr = await this.gh<{ number: number; html_url: string }>(
      "POST", `${this.repoPath(ref)}/pulls`, actor.name, {
        title: spec.title, head: spec.head, base: spec.base, body: spec.body,
      });
    return { number: pr.number, url: pr.html_url };
  }

  async comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult> {
    const c = await this.gh<{ id: number; html_url: string }>(
      "POST", `${this.repoPath(ref)}/issues/${issue}/comments`, actor.name, { body });
    return { id: c.id, url: c.html_url };
  }

  async fork(ref: RepoRef, actor: Author): Promise<ForkResult> {
    const f = await this.gh<{ name: string; owner: { login: string }; default_branch: string }>(
      "POST", `${this.repoPath(ref)}/forks`, actor.name);
    return { owner: f.owner.login, repo: f.name, defaultBranch: f.default_branch };
  }

  /** GitHub's merge-upstream endpoint, on the FORK, brings `branch` level
   *  with the upstream branch of the same name. It runs on the PAT (the fork
   *  account's own credential), not the commit-path token: a fast-forward is
   *  a ref move GitHub performs server-side, not a commit the proxy
   *  constructs, so there is nothing to sign (#120) and the installation
   *  token's narrow commit-API grant is not the right fit.
   *
   *  GitHub's contract is wider than a fast-forward, though: a fork branch
   *  whose own commits merge cleanly gets a MERGE COMMIT authored by the
   *  fork account (merge_type "merge"), and only a conflicting branch is
   *  refused with 409. Such a commit is neither authored as the acting
   *  identity nor signed, which breaks the proxy's by-construction
   *  authorship property, and because the fork account is shared it could
   *  land on a branch another identity is working on. The write would
   *  happen before the proxy learned of it, so the only defence is to fail
   *  closed BEFORE the call: compare the fork branch against its upstream
   *  and refuse any branch that is ahead at all, not just a conflicting
   *  one. The 409 mapping below stays as the backstop for a race between the
   *  compare and the merge. repoPath() has pinned owner/repo to single
   *  segments and the proxy policy has pinned the ref to the fork namespace
   *  before this runs. */
  async syncFork(ref: RepoRef, branch: string, actor: Author): Promise<SyncResult> {
    const r = this.repoPath(ref);
    const name = `${ref.owner}/${ref.name}@${branch}`;
    const diverged = () => new ForgeError("fork_diverged",
      `${name} is ahead of its upstream and cannot be fast-forwarded; the proxy never `
      + "merges on the agent's behalf, so start a new branch from the fresh base instead", 409);

    // The upstream is whatever GitHub says the fork's parent is. A repo with
    // no parent is not a fork and has nothing to sync from; merge-upstream
    // would answer 422 for it, so say so up front in the same terms.
    const repo = await this.gh<{ parent?: { owner: { login: string } } }>("GET", r, actor.name);
    if (!repo.parent) {
      throw new ForgeError("invalid",
        `cannot sync ${name}: ${ref.owner}/${ref.name} is not a fork`, 422);
    }
    // base...head: `ahead_by` is the number of commits the fork branch has
    // that the upstream branch lacks — any at all means a sync would merge.
    // Every piece is encoded so the branch stays one path unit (dot
    // segments must not re-target the URL outside `r`).
    const basehead = `${encodeURIComponent(repo.parent.owner.login)}:${encodeURIComponent(branch)}`
      + `...${encodeURIComponent(branch)}`;
    let cmp: { ahead_by: number };
    try {
      cmp = await this.gh<{ ahead_by: number }>("GET", `${r}/compare/${basehead}`, actor.name);
    } catch (err) {
      // compare 404s when either side of the range is missing: the branch
      // is not on the fork or not on the upstream. Neither is a "not found"
      // the caller can retry; it is a bad request for this sync.
      // (A fork renamed away from its parent's name can also 404 here, since
      // the OWNER:BRANCH form resolves the parent by owner alone.)
      if (err instanceof ForgeError && err.kind === "not_found") {
        throw new ForgeError("invalid",
          `cannot sync ${name}: the branch does not exist on the fork or on its upstream `
          + "(or the fork is renamed from its parent)", 422);
      }
      throw err;
    }
    if (cmp.ahead_by > 0) throw diverged();

    try {
      const s = await this.gh<{ merge_type: string; base_branch: string; message: string }>(
        "POST", `${r}/merge-upstream`, actor.name, { branch });
      // The pre-check should make "merge" impossible; it can still happen if
      // a commit landed on the fork branch between the compare and the
      // merge. The result is passed through unchanged so the route audits
      // and attests the mergeType it actually got — the ledger must show
      // that a bot-authored merge commit now exists rather than hide it.
      // The value is narrowed first: it reaches attested events and the
      // public fleet projection, which must never carry a string the forge
      // invented. The ref move may already have happened by now, so this is
      // reported as an upstream error rather than passed through.
      if (!isMergeType(s.merge_type)) {
        throw new ForgeError("invalid",
          `github returned an unrecognised merge_type for ${name}`, 502);
      }
      return { mergeType: s.merge_type, baseBranch: s.base_branch, message: s.message };
    } catch (err) {
      if (!(err instanceof ForgeError)) throw err;
      // GitHub answers 409 only when the fork branch's own commits CONFLICT
      // with upstream (a clean divergence is merged, not refused). The
      // compare above refuses any ahead branch first, so reaching this means
      // the branch moved under us; the remedy is the same.
      if (err.upstream === 409) throw diverged();
      // 422 is GitHub's "cannot do that here": the branch does not exist on
      // the fork, or the repo is not a fork at all. mapError's generic 422
      // text is GitHub's "Validation Failed"; say what it means for this
      // call. Narrowed to the generic kind so a 422 mapError already read as
      // non_fast_forward keeps that meaning instead of being relabelled.
      if (err.kind === "invalid" && err.upstream === 422) {
        throw new ForgeError("invalid",
          `cannot sync ${name}: the branch does not exist on the fork or the repo is not a fork`, 422);
      }
      throw err;
    }
  }

  async repoVisibility(ref: RepoRef, actor: Author): Promise<RepoVisibility> {
    const r = await this.gh<{ private?: boolean; visibility?: string }>(
      "GET", this.repoPath(ref), actor.name);
    // "public" only when the payload AFFIRMS world-readability: private must
    // be exactly false, and any `visibility` field (GHES adds "internal")
    // must be exactly "public" when present. Anything else — including a
    // malformed payload — proves nothing and reads as private.
    return r.private === false && (r.visibility === undefined || r.visibility === "public")
      ? "public" : "private";
  }
}
