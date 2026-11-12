import type {
  BlobResult, BlobSpec, CommentResult, CommitChangesSpec, CommitResult, CommitSpec,
  ForkResult, IssueResult, IssueSpec, IssueUpdateSpec, PrResult, PrSpec, PrUpdateSpec,
  RepoInfo, RepoRef, RepoVisibility, SyncResult,
} from "@agent-identity/shared";
import {
  ForgeError, type Author, type CredentialStore, type Forge,
} from "./forge.js";
import { gitlabServiceAccountUsername } from "./gitlab-names.js";
import { matchLabels } from "./issue-labels.js";
import { withProxyFooters } from "./pr-footers.js";

/** Upper bound on label-list pages read per issue write (100 per page). */
const LABEL_PAGES = 10;

/** The parts of a GitLab issue payload the issue ops read. */
interface GitlabIssue {
  iid: number;
  web_url: string;
  state: string;          // "opened" | "closed"
  labels?: string[];
}

function gitlabIssueResult(issue: GitlabIssue): IssueResult {
  return {
    number: issue.iid,
    url: issue.web_url,
    state: issue.state === "closed" ? "closed" : "open",
    labels: (issue.labels ?? []).filter((l): l is string => typeof l === "string"),
  };
}

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

  /** An MR is edited through the project it targets (`ref`); for a
   *  cross-project MR from a fork the iid still lives on the source project
   *  the agent names, which is where openPullRequest returned it from. The
   *  author must be this identity's own service account: GitLab forks are
   *  per identity, so no other agent's MR is ever editable here. */
  async updatePullRequest(
    ref: RepoRef, number: number, spec: PrUpdateSpec, attribution: string, actor: Author,
  ): Promise<PrResult> {
    const path = `/projects/${this.project(ref)}/merge_requests/${number}`;
    const mr = await this.gl<{ description: string | null; author: { username: string } }>(
      "GET", path, actor.name);
    const me = gitlabServiceAccountUsername(actor.name);
    if (mr.author.username !== me) {
      throw new ForgeError("forbidden",
        `MR !${number} on ${ref.owner}/${ref.name} was opened by ${mr.author.username}, `
        + `not by this identity (${me}); only its own MRs can be edited`, 403);
    }
    const put: { title?: string; description?: string } = {};
    if (spec.title !== undefined) put.title = spec.title;
    if (spec.body !== undefined) {
      put.description = withProxyFooters(mr.description ?? "", spec.body, attribution);
    }
    const updated = await this.gl<{ iid: number; web_url: string }>("PUT", path, actor.name, put);
    return { number: updated.iid, url: updated.web_url };
  }

  /** Labels the project can apply (its own and its ancestor groups'), paged
   *  100 at a time and capped like the GitHub adapter: a label beyond the
   *  cap reads as unknown, which fails closed. */
  private async projectLabels(p: string, agentId: string): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; page <= LABEL_PAGES; page++) {
      const batch = await this.gl<{ name: string }[]>(
        "GET", `/projects/${p}/labels?per_page=100&page=${page}`, agentId);
      names.push(...batch.map((l) => l.name));
      if (batch.length < 100) break;
    }
    return names;
  }

  private async resolveLabels(
    ref: RepoRef, p: string, wanted: string[] | undefined, agentId: string,
  ): Promise<string[] | undefined> {
    if (!wanted || wanted.length === 0) return wanted;
    return matchLabels(ref, wanted, await this.projectLabels(p, agentId));
  }

  /** GitLab assigns by user id; resolve each username first so an unknown
   *  one is refused before the write rather than silently ignored. */
  private async assigneeIds(usernames: string[], agentId: string): Promise<number[]> {
    const ids: number[] = [];
    for (const u of usernames) {
      const users = await this.gl<{ id: number; username: string }[]>(
        "GET", `/users?username=${encodeURIComponent(u)}`, agentId);
      const hit = users.find((x) => x.username.toLowerCase() === u.toLowerCase());
      if (!hit) throw new ForgeError("invalid", `unknown gitlab assignee "${u}"`, 422);
      ids.push(hit.id);
    }
    return ids;
  }

  /** `milestone` is the project milestone's iid (the %N the UI shows); the
   *  issues API wants its global id. */
  private async milestoneId(ref: RepoRef, p: string, iid: number, agentId: string): Promise<number> {
    const ms = await this.gl<{ id: number; iid: number }[]>(
      "GET", `/projects/${p}/milestones?iids[]=${iid}`, agentId);
    const hit = ms.find((m) => m.iid === iid);
    if (!hit) throw new ForgeError("invalid", `no milestone %${iid} on ${ref.owner}/${ref.name}`, 422);
    return hit.id;
  }

  async openIssue(ref: RepoRef, spec: IssueSpec, actor: Author): Promise<IssueResult> {
    const p = this.project(ref);
    // Every lookup runs before the write, so any unknown value creates nothing.
    const labels = await this.resolveLabels(ref, p, spec.labels, actor.name);
    const post: Record<string, unknown> = { title: spec.title, description: spec.body };
    if (labels !== undefined) post.labels = labels.join(",");
    if (spec.assignees !== undefined) post.assignee_ids = await this.assigneeIds(spec.assignees, actor.name);
    if (spec.milestone !== undefined) post.milestone_id = await this.milestoneId(ref, p, spec.milestone, actor.name);
    return gitlabIssueResult(await this.gl<GitlabIssue>("POST", `/projects/${p}/issues`, actor.name, post));
  }

  /** Author-gated like updatePullRequest: only an issue this identity's own
   *  service account opened can be edited. */
  async updateIssue(
    ref: RepoRef, number: number, spec: IssueUpdateSpec, attribution: string, actor: Author,
  ): Promise<IssueResult> {
    const p = this.project(ref);
    const path = `/projects/${p}/issues/${number}`;
    const issue = await this.gl<GitlabIssue & { description: string | null; author: { username: string } }>(
      "GET", path, actor.name);
    const me = gitlabServiceAccountUsername(actor.name);
    if (issue.author.username !== me) {
      throw new ForgeError("forbidden",
        `issue #${number} on ${ref.owner}/${ref.name} was opened by ${issue.author.username}, `
        + `not by this identity (${me}); only its own issues can be edited`, 403);
    }
    const labels = await this.resolveLabels(ref, p, spec.labels, actor.name);
    const put: Record<string, unknown> = {};
    if (spec.title !== undefined) put.title = spec.title;
    if (spec.body !== undefined) {
      put.description = withProxyFooters(issue.description ?? "", spec.body, attribution);
    }
    // GitLab replaces the label set from a comma list; "" clears it.
    if (labels !== undefined) put.labels = labels.join(",");
    if (spec.state !== undefined) put.state_event = spec.state === "closed" ? "close" : "reopen";
    return gitlabIssueResult(await this.gl<GitlabIssue>("PUT", path, actor.name, put));
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
