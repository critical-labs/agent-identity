import type {
  CommentResult, CommitResult, CommitSpec, PrResult, PrSpec, RepoInfo, RepoRef,
} from "@agent-identity/shared";
import {
  ForgeError, type Author, type CredentialStore, type Forge,
} from "./forge.js";

export interface GithubForgeOptions {
  credentials: CredentialStore;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
}

export class GithubForge implements Forge {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly base: string;

  constructor(private readonly opts: GithubForgeOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.base = opts.apiBase ?? "https://api.github.com";
  }

  private async gh<T>(method: string, path: string, agentId: string, body?: unknown): Promise<T> {
    const token = await this.opts.credentials.resolve("github", agentId);
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

  async getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo> {
    const r = `/repos/${ref.owner}/${ref.name}`;
    const repo = await this.gh<{ default_branch: string }>("GET", r, actor.name);
    const head = await this.gh<{ object: { sha: string } }>(
      "GET", `${r}/git/ref/heads/${repo.default_branch}`, actor.name);
    return { defaultBranch: repo.default_branch, headSha: head.object.sha };
  }

  async createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult> {
    const r = `/repos/${ref.owner}/${ref.name}`;
    const head = await this.gh<{ object: { sha: string } }>(
      "GET", `${r}/git/ref/heads/${spec.branch}`, actor.name);
    const baseCommit = await this.gh<{ tree: { sha: string } }>(
      "GET", `${r}/git/commits/${head.object.sha}`, actor.name);
    const tree = await this.gh<{ sha: string }>("POST", `${r}/git/trees`, actor.name, {
      base_tree: baseCommit.tree.sha,
      tree: spec.files.map((f) => ({
        path: f.path, mode: "100644", type: "blob", content: f.content,
      })),
    });
    // Only `author` is set to the acting identity; `committer` is
    // intentionally left to GitHub's default (the PAT account) — that split
    // is the attribution model, not an oversight.
    const commit = await this.gh<{ sha: string; html_url: string }>(
      "POST", `${r}/git/commits`, actor.name, {
        message: spec.message, tree: tree.sha, parents: [head.object.sha],
        author: { name: actor.name, email: actor.email },
      });
    await this.gh("PATCH", `${r}/git/refs/heads/${spec.branch}`, actor.name,
      { sha: commit.sha, force: false });
    return { sha: commit.sha, url: commit.html_url };
  }

  async openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult> {
    const pr = await this.gh<{ number: number; html_url: string }>(
      "POST", `/repos/${ref.owner}/${ref.name}/pulls`, actor.name, {
        title: spec.title, head: spec.head, base: spec.base, body: spec.body,
      });
    return { number: pr.number, url: pr.html_url };
  }

  async comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult> {
    const c = await this.gh<{ id: number; html_url: string }>(
      "POST", `/repos/${ref.owner}/${ref.name}/issues/${issue}/comments`, actor.name, { body });
    return { id: c.id, url: c.html_url };
  }
}
