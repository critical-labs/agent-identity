import type {
  BlobResult, BlobSpec, CommentResult, CommitChangesSpec, CommitResult, CommitSpec,
  ForkResult, PrResult, PrSpec, RepoInfo, RepoRef,
  RepoVisibility, SyncResult,
} from "@agent-identity/shared";
import {
  ForgeError, type Author, type CredentialStore, type Forge,
} from "./forge.js";
import { gitlabServiceAccountUsername } from "./gitlab-names.js";

export interface GitlabForgeOptions {
  credentials: CredentialStore;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;   // default https://gitlab.com/api/v4
  webBase?: string;   // default https://gitlab.com
}

export class GitlabForge implements Forge {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly base: string;
  private readonly web: string;

  constructor(private readonly opts: GitlabForgeOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.base = opts.apiBase ?? "https://gitlab.com/api/v4";
    this.web = opts.webBase ?? "https://gitlab.com";
  }

  private project(ref: RepoRef): string {
    return encodeURIComponent(`${ref.owner}/${ref.name}`);
  }

  private async gl<T>(method: string, path: string, agentId: string, body?: unknown): Promise<T> {
    const token = await this.opts.credentials.resolve("gitlab", agentId);
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await this.mapError(res);
    return res.json() as Promise<T>;
  }

  private async mapError(res: Response): Promise<ForgeError> {
    const text = await res.text();
    if (res.status === 401) return new ForgeError("upstream_auth", "gitlab rejected the credential", 401);
    if (res.status === 404) return new ForgeError("not_found", "not found on gitlab", 404);
    if (res.status === 403) return new ForgeError("forbidden", "gitlab forbade the operation for this credential", 403);
    if (res.status === 429) return new ForgeError("rate_limited", "gitlab rate limit", 429);
    return new ForgeError("invalid", `gitlab ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  private async fileExists(project: string, filePath: string, branch: string, agentId: string): Promise<boolean> {
    try {
      await this.gl("GET",
        `/projects/${project}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
        agentId);
      return true;
    } catch (err) {
      if (err instanceof ForgeError && err.kind === "not_found") return false;
      throw err;
    }
  }

  async getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo> {
    const p = this.project(ref);
    const proj = await this.gl<{ default_branch: string }>("GET", `/projects/${p}`, actor.name);
    const branch = await this.gl<{ commit: { id: string } }>(
      "GET", `/projects/${p}/repository/branches/${proj.default_branch}`, actor.name);
    return { defaultBranch: proj.default_branch, headSha: branch.commit.id };
  }

  private async branchExists(project: string, branch: string, agentId: string): Promise<boolean> {
    try {
      await this.gl("GET",
        `/projects/${project}/repository/branches/${encodeURIComponent(branch)}`, agentId);
      return true;
    } catch (err) {
      if (err instanceof ForgeError && err.kind === "not_found") return false;
      throw err;
    }
  }

  /** Auto-create a missing target branch from the project's OWN default
   *  branch (issue #93) so a fresh fork needs no raw-PAT branch setup. Runs
   *  only inside createCommit, which the proxy policy-gates before any call. */
  private async ensureBranch(project: string, branch: string, agentId: string): Promise<void> {
    if (await this.branchExists(project, branch, agentId)) return;
    const proj = await this.gl<{ default_branch: string | null }>(
      "GET", `/projects/${project}`, agentId);
    // An empty project (fresh fork still importing) has no default branch yet
    // — surface the existing retryable not_found, not a new error class.
    if (!proj.default_branch)
      throw new ForgeError("not_found", "project has no default branch yet", 404);
    try {
      await this.gl("POST", `/projects/${project}/repository/branches`, agentId,
        { branch, ref: proj.default_branch });
    } catch (err) {
      // The branch appeared between check and create — commit onto it as-is.
      if (err instanceof ForgeError && (err.upstream === 400 || err.upstream === 409)
        && /already exists/i.test(err.message)) return;
      throw err;
    }
  }

  /** Post the commit with authorship FORCED to the acting identity. The
   *  namespace pin (fork-namespace policy) and app-layer validation run in
   *  the proxy BEFORE this adapter is reached, so a rejected target writes
   *  nothing. */
  private async postCommit(
    p: string, branch: string, message: string,
    actions: Record<string, unknown>[], actor: Author,
  ): Promise<CommitResult> {
    const commit = await this.gl<{ id: string; web_url: string }>(
      "POST", `/projects/${p}/repository/commits`, actor.name, {
        branch, commit_message: message,
        author_name: actor.name, author_email: actor.email,
        actions,
      });
    return { sha: commit.id, url: commit.web_url };
  }

  async createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult> {
    const p = this.project(ref);
    await this.ensureBranch(p, spec.branch, actor.name);
    const actions: Record<string, unknown>[] = [];
    for (const f of spec.files) {
      const exists = await this.fileExists(p, f.path, spec.branch, actor.name);
      actions.push({ action: exists ? "update" : "create", file_path: f.path, content: f.content });
    }
    return this.postCommit(p, spec.branch, spec.message, actions, actor);
  }

  /** GitLab's commits API carries content inline, so there is no separate
   *  blob object to upload; the MCP server passes content base64-encoded in
   *  commitChanges instead. Made explicit rather than a silent no-op so a
   *  mis-routed GitHub-style blob upload fails loudly. */
  async putBlob(_ref: RepoRef, _spec: BlobSpec, _actor: Author): Promise<BlobResult> {
    throw new ForgeError(
      "invalid",
      "gitlab does not support blob upload; content is carried inline via commitChanges",
      400);
  }

  /** Size-agnostic commit via the commits API actions array (#118). Each
   *  add/modify carries base64 `content` (encoding:"base64"); create vs
   *  update is probed per file exactly as createCommit; a deletion is a
   *  "delete" action. NOTE: GitLab enforces a per-commit payload size limit
   *  (the whole change travels in one request), so very large deliveries can
   *  exceed it — GitHub's per-file blob streaming has no such ceiling. */
  async commitChanges(ref: RepoRef, spec: CommitChangesSpec, actor: Author): Promise<CommitResult> {
    const p = this.project(ref);
    await this.ensureBranch(p, spec.branch, actor.name);
    const actions: Record<string, unknown>[] = [];
    for (const c of spec.changes) {
      if ("deleted" in c) {
        actions.push({ action: "delete", file_path: c.path });
        continue;
      }
      if ("blobSha" in c) {
        throw new ForgeError(
          "invalid",
          "gitlab commits carry content inline; blob references are not supported", 400);
      }
      const exists = await this.fileExists(p, c.path, spec.branch, actor.name);
      actions.push({
        action: exists ? "update" : "create",
        file_path: c.path, content: c.content, encoding: "base64",
      });
    }
    return this.postCommit(p, spec.branch, spec.message, actions, actor);
  }

  async openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult> {
    // A "<forkOwner>:<branch>" head means a cross-project MR from the fork to
    // the source (ref) — the fork-and-PR flow. GitLab creates the MR on the
    // SOURCE (fork) project with target_project_id pointing at the upstream.
    // A bare branch name is a same-project MR.
    const colon = spec.head.indexOf(":");
    if (colon === -1) {
      const mr = await this.gl<{ iid: number; web_url: string }>(
        "POST", `/projects/${this.project(ref)}/merge_requests`, actor.name, {
          source_branch: spec.head, target_branch: spec.base,
          title: spec.title, description: spec.body,
        });
      return { number: mr.iid, url: mr.web_url };
    }
    const forkOwner = spec.head.slice(0, colon);
    const sourceBranch = spec.head.slice(colon + 1);
    const upstream = await this.gl<{ id: number }>("GET", `/projects/${this.project(ref)}`, actor.name);
    const mr = await this.gl<{ iid: number; web_url: string }>(
      "POST", `/projects/${this.project({ owner: forkOwner, name: ref.name })}/merge_requests`,
      actor.name, {
        source_branch: sourceBranch, target_branch: spec.base,
        title: spec.title, description: spec.body, target_project_id: upstream.id,
      });
    return { number: mr.iid, url: mr.web_url };
  }

  async comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult> {
    const note = await this.gl<{ id: number }>(
      "POST", `/projects/${this.project(ref)}/issues/${issue}/notes`, actor.name, { body });
    return {
      id: note.id,
      url: `${this.web}/${ref.owner}/${ref.name}/-/issues/${issue}#note_${note.id}`,
    };
  }

  async fork(ref: RepoRef, actor: Author): Promise<ForkResult> {
    type Project = { path: string; default_branch: string; namespace: { full_path: string } };
    try {
      const f = await this.gl<Project>("POST", `/projects/${this.project(ref)}/fork`, actor.name);
      return { owner: f.namespace.full_path, repo: f.path, defaultBranch: f.default_branch };
    } catch (err) {
      // Already forked into our namespace (409) — return the existing fork so
      // fork is idempotent, matching GitHub's behavior.
      if (!(err instanceof ForgeError && err.upstream === 409)) throw err;
      const existing = { owner: gitlabServiceAccountUsername(actor.name), name: ref.name };
      const p = await this.gl<Project>("GET", `/projects/${this.project(existing)}`, actor.name);
      return { owner: p.namespace.full_path, repo: p.path, defaultBranch: p.default_branch };
    }
  }

  /** GitLab has no merge-upstream endpoint, and the need is weaker there:
   *  every identity forks into its OWN service-account namespace, so a stale
   *  fork is simply re-created fresh (the fork is per identity, not a shared
   *  account's long-lived copy as on GitHub). Refused explicitly, in
   *  putBlob's unsupported style, rather than treated as a silent no-op, so
   *  a GitHub-style sync routed here fails loudly instead of pretending the
   *  fork is level. */
  async syncFork(_ref: RepoRef, _branch: string, _actor: Author): Promise<SyncResult> {
    throw new ForgeError(
      "invalid",
      "gitlab does not support syncing a fork from upstream; re-fork to get a fresh base",
      400);
  }

  async repoVisibility(ref: RepoRef, actor: Author): Promise<RepoVisibility> {
    const p = await this.gl<{ visibility?: string }>(
      "GET", `/projects/${this.project(ref)}`, actor.name);
    // GitLab's own tri-state: only "public" is world-readable; "internal"
    // (any signed-in user) and "private" — and a missing field — are not.
    return p.visibility === "public" ? "public" : "private";
  }
}
