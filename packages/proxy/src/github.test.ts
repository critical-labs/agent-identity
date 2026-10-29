import { describe, expect, it, vi } from "vitest";
import { type CommitSigner, type CredentialStore, ForgeError } from "./forge.js";
import { GithubForge } from "./github.js";
import { FIX_KEY } from "./sshsig.fixture.js";
import { sshSign } from "./sshsig.js";

const credentials: CredentialStore = {
  resolve: async () => "tok123",
  resolveCommitToken: async () => "commit-tok",
  resolveCommitSigner: async () => undefined,
};
const actor = { name: "482913", email: "482913@agents.example" };

type FakeRoute = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/** fetch fake: responds per "METHOD url" from a routing table; records calls.
 *  An array value answers in sequence (last entry repeats) — for endpoints
 *  whose response changes between calls, e.g. a ref that appears mid-flow. */
function makeFetch(routes: Record<string, FakeRoute | FakeRoute[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const entry = routes[key];
    const route = Array.isArray(entry)
      ? (entry.length > 1 ? entry.shift() : entry[0])
      : entry;
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    const body = route.text ?? JSON.stringify(route.json ?? {});
    return new Response(body, { status: route.status ?? 200, headers: route.headers });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const B = "https://api.github.com/repos/o/r";

describe("GithubForge.getRepo", () => {
  it("returns default branch and its head sha, resolving the actor's credential", async () => {
    const resolve = vi.fn(async () => "tok123");
    const { fn, calls } = makeFetch({
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "abc123" } } },
    });
    const forge = new GithubForge({
      credentials: { resolve, resolveCommitToken: resolve, resolveCommitSigner: async () => undefined },
      fetch: fn,
    });
    const info = await forge.getRepo({ owner: "o", name: "r" }, actor);
    expect(info).toEqual({ defaultBranch: "main", headSha: "abc123" });
    expect(resolve).toHaveBeenCalledWith("github", "482913");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("authorization")).toBe("Bearer tok123");
  });

  it("maps 404 to not_found", async () => {
    const { fn } = makeFetch({ [`GET ${B}`]: { status: 404, json: { message: "Not Found" } } });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "not_found" });
  });

  it("maps 401 to upstream_auth", async () => {
    const { fn } = makeFetch({ [`GET ${B}`]: { status: 401, json: { message: "Bad credentials" } } });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "upstream_auth", upstream: 401 });
  });

  it("maps exhausted rate limit to rate_limited", async () => {
    const { fn } = makeFetch({
      [`GET ${B}`]: {
        status: 403, json: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("maps a non-rate-limit 403 to forbidden (not invalid)", async () => {
    const { fn } = makeFetch({
      [`GET ${B}`]: {
        status: 403, json: { message: "Resource not accessible by personal access token" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("GithubForge.createCommit", () => {
  const routes = {
    [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "head1" } } },
    [`GET ${B}/git/commits/head1`]: { json: { tree: { sha: "tree0" } } },
    [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
    [`POST ${B}/git/commits`]: { json: { sha: "commit1", html_url: "https://github.com/o/r/commit/commit1" } },
    [`PATCH ${B}/git/refs/heads/main`]: { json: { object: { sha: "commit1" } } },
  };
  const spec = {
    branch: "main", message: "feat: x",
    files: [{ path: "a.txt", content: "A" }],
  };

  it("runs ref → base commit → tree → commit → fast-forward ref update", async () => {
    const { fn, calls } = makeFetch(routes);
    const forge = new GithubForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, spec, actor);
    expect(result).toEqual({ sha: "commit1", url: "https://github.com/o/r/commit/commit1" });

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(JSON.parse(treeCall.init.body as string)).toEqual({
      base_tree: "tree0",
      tree: [{ path: "a.txt", mode: "100644", type: "blob", content: "A" }],
    });

    const commitCall = calls.find((c) => c.url.endsWith("/git/commits") && c.init.method === "POST")!;
    expect(JSON.parse(commitCall.init.body as string)).toEqual({
      message: "feat: x", tree: "tree1", parents: ["head1"],
      author: { name: "482913", email: "482913@agents.example" },
    });

    const refCall = calls.find((c) => c.init.method === "PATCH")!;
    expect(JSON.parse(refCall.init.body as string)).toEqual({ sha: "commit1", force: false });
  });

  it("maps a non-fast-forward 422 to non_fast_forward", async () => {
    const { fn } = makeFetch({
      ...routes,
      [`PATCH ${B}/git/refs/heads/main`]: {
        status: 422, json: { message: "Update is not a fast forward" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.createCommit({ owner: "o", name: "r" }, spec, actor))
      .rejects.toMatchObject({ kind: "non_fast_forward" });
  });
});

describe("GithubForge.createCommit branch auto-create", () => {
  const spec = {
    branch: "feat-x", message: "feat: x",
    files: [{ path: "a.txt", content: "A" }],
  };

  it("creates a missing branch from the repo's OWN default-branch head, then commits", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${B}/git/ref/heads/feat-x`]: { status: 404, json: { message: "Not Found" } },
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "defhead" } } },
      [`POST ${B}/git/refs`]: { status: 201, json: { ref: "refs/heads/feat-x", object: { sha: "defhead" } } },
      [`GET ${B}/git/commits/defhead`]: { json: { tree: { sha: "tree0" } } },
      [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
      [`POST ${B}/git/commits`]: { json: { sha: "commit1", html_url: "https://github.com/o/r/commit/commit1" } },
      [`PATCH ${B}/git/refs/heads/feat-x`]: { json: { object: { sha: "commit1" } } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, spec, actor);
    expect(result).toEqual({ sha: "commit1", url: "https://github.com/o/r/commit/commit1" });

    const refCreate = calls.findIndex((c) => c.url.endsWith("/git/refs") && c.init.method === "POST");
    expect(refCreate).toBeGreaterThan(-1);
    expect(JSON.parse(calls[refCreate]!.init.body as string)).toEqual({
      ref: "refs/heads/feat-x", sha: "defhead",
    });
    const commitPost = calls.findIndex((c) => c.url.endsWith("/git/commits") && c.init.method === "POST");
    expect(refCreate).toBeLessThan(commitPost);
    expect(JSON.parse(calls[commitPost]!.init.body as string).parents).toEqual(["defhead"]);
  });

  it("falls through to committing when the ref appears between check and create", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${B}/git/ref/heads/feat-x`]: [
        { status: 404, json: { message: "Not Found" } },
        { json: { object: { sha: "racedhead" } } },
      ],
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "defhead" } } },
      [`POST ${B}/git/refs`]: { status: 422, json: { message: "Reference already exists" } },
      [`GET ${B}/git/commits/racedhead`]: { json: { tree: { sha: "tree0" } } },
      [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
      [`POST ${B}/git/commits`]: { json: { sha: "commit1", html_url: "https://github.com/o/r/commit/commit1" } },
      [`PATCH ${B}/git/refs/heads/feat-x`]: { json: { object: { sha: "commit1" } } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, spec, actor);
    expect(result).toEqual({ sha: "commit1", url: "https://github.com/o/r/commit/commit1" });
    const commitPost = calls.find((c) => c.url.endsWith("/git/commits") && c.init.method === "POST")!;
    expect(JSON.parse(commitPost.init.body as string).parents).toEqual(["racedhead"]);
  });

  it("surfaces retryable not_found for an empty repo (fresh fork still importing), writing nothing", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${B}/git/ref/heads/feat-x`]: { status: 404, json: { message: "Not Found" } },
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { status: 404, json: { message: "Git Repository is empty." } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.createCommit({ owner: "o", name: "r" }, spec, actor))
      .rejects.toMatchObject({ kind: "not_found" });
    expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
  });
});

describe("GithubForge.putBlob", () => {
  it("POSTs a base64 blob and returns its sha", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${B}/git/blobs`]: { json: { sha: "blobsha1" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const res = await forge.putBlob({ owner: "o", name: "r" }, { contentBase64: "QUJD" }, actor);
    expect(res).toEqual({ sha: "blobsha1" });
    const call = calls.find((c) => c.url.endsWith("/git/blobs"))!;
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(call.init.body as string)).toEqual({ content: "QUJD", encoding: "base64" });
  });

  it("rejects a multi-segment repo before any request (path pinning)", async () => {
    const { fn, calls } = makeFetch({});
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.putBlob(
      { owner: "fork-acct", name: "proxy/../../src/agent-identity" },
      { contentBase64: "QQ==" }, actor,
    )).rejects.toMatchObject({ kind: "invalid" });
    expect(calls).toHaveLength(0);
  });
});

describe("GithubForge.commitChanges", () => {
  const baseRoutes = {
    [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "head1" } } },
    [`GET ${B}/git/commits/head1`]: { json: { tree: { sha: "tree0" } } },
    [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
    [`POST ${B}/git/commits`]: { json: { sha: "commit1", html_url: "https://github.com/o/r/commit/commit1" } },
    [`PATCH ${B}/git/refs/heads/main`]: { json: { object: { sha: "commit1" } } },
  };

  it("builds base_tree + blob-sha entries + deletion (sha:null) and forces the author", async () => {
    const { fn, calls } = makeFetch(baseRoutes);
    const forge = new GithubForge({ credentials, fetch: fn });
    const result = await forge.commitChanges({ owner: "o", name: "r" }, {
      branch: "main", message: "feat: big",
      changes: [
        { path: "add.bin", blobSha: "b-add" },
        { path: "keep.txt", content: "inline" },
        { path: "gone.txt", deleted: true },
      ],
    }, actor);
    expect(result).toEqual({ sha: "commit1", url: "https://github.com/o/r/commit/commit1" });

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(JSON.parse(treeCall.init.body as string)).toEqual({
      base_tree: "tree0",
      tree: [
        { path: "add.bin", mode: "100644", type: "blob", sha: "b-add" },
        { path: "keep.txt", mode: "100644", type: "blob", content: "inline" },
        { path: "gone.txt", mode: "100644", type: "blob", sha: null },
      ],
    });

    const commitCall = calls.find((c) => c.url.endsWith("/git/commits") && c.init.method === "POST")!;
    expect(JSON.parse(commitCall.init.body as string)).toEqual({
      message: "feat: big", tree: "tree1", parents: ["head1"],
      author: { name: "482913", email: "482913@agents.example" },
    });
    const refCall = calls.find((c) => c.init.method === "PATCH")!;
    expect(JSON.parse(refCall.init.body as string)).toEqual({ sha: "commit1", force: false });
  });

  it("auto-creates a missing branch from the repo's own default head, then commits", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${B}/git/ref/heads/feat-x`]: { status: 404, json: { message: "Not Found" } },
      [`GET ${B}`]: { json: { default_branch: "main" } },
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "defhead" } } },
      [`POST ${B}/git/refs`]: { status: 201, json: { object: { sha: "defhead" } } },
      [`GET ${B}/git/commits/defhead`]: { json: { tree: { sha: "tree0" } } },
      [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
      [`POST ${B}/git/commits`]: { json: { sha: "commit1", html_url: "u" } },
      [`PATCH ${B}/git/refs/heads/feat-x`]: { json: {} },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await forge.commitChanges({ owner: "o", name: "r" }, {
      branch: "feat-x", message: "m", changes: [{ path: "a", blobSha: "b1" }],
    }, actor);
    const refCreate = calls.findIndex((c) => c.url.endsWith("/git/refs") && c.init.method === "POST");
    const commitPost = calls.findIndex((c) => c.url.endsWith("/git/commits") && c.init.method === "POST");
    expect(refCreate).toBeGreaterThan(-1);
    expect(refCreate).toBeLessThan(commitPost);
    expect(JSON.parse(calls[commitPost]!.init.body as string).parents).toEqual(["defhead"]);
  });

  it("streams many files as one commit (each already a blob sha)", async () => {
    const { fn, calls } = makeFetch(baseRoutes);
    const forge = new GithubForge({ credentials, fetch: fn });
    const changes = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}`, blobSha: `b${i}` }));
    await forge.commitChanges({ owner: "o", name: "r" }, { branch: "main", message: "m", changes }, actor);
    // one tree, one commit, one ref update — no per-file upstream write here
    expect(calls.filter((c) => c.url.endsWith("/git/trees")).length).toBe(1);
    expect(calls.filter((c) => c.url.endsWith("/git/commits") && c.init.method === "POST").length).toBe(1);
    const treeBody = JSON.parse(calls.find((c) => c.url.endsWith("/git/trees"))!.init.body as string);
    expect(treeBody.tree).toHaveLength(40);
  });
});

describe("GithubForge.openPullRequest and comment", () => {
  it("opens a PR", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${B}/pulls`]: { json: { number: 5, html_url: "https://github.com/o/r/pull/5" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const pr = await forge.openPullRequest({ owner: "o", name: "r" },
      { head: "f", base: "main", title: "t", body: "b" }, actor);
    expect(pr).toEqual({ number: 5, url: "https://github.com/o/r/pull/5" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      title: "t", head: "f", base: "main", body: "b",
    });
  });

  it("comments on an issue", async () => {
    const { fn } = makeFetch({
      [`POST ${B}/issues/12/comments`]: { json: { id: 33, html_url: "https://github.com/o/r/issues/12#c33" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const c = await forge.comment({ owner: "o", name: "r" }, 12, "hello", actor);
    expect(c).toEqual({ id: 33, url: "https://github.com/o/r/issues/12#c33" });
  });
});

describe("GithubForge.fork", () => {
  it("forks under the credential account and returns the fork coordinates", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${B}/forks`]: {
        json: { name: "r", owner: { login: "critical-agent-zero" }, default_branch: "main" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const fork = await forge.fork({ owner: "o", name: "r" }, actor);
    expect(fork).toEqual({ owner: "critical-agent-zero", repo: "r", defaultBranch: "main" });
    expect(calls[0]!.init.method).toBe("POST");
  });
});

describe("GithubForge.syncFork", () => {
  const FORK = "https://api.github.com/repos/critical-agent-zero/r";
  const fork = { owner: "critical-agent-zero", name: "r" };
  // The fork's parent, as GET /repos/{fork} reports it.
  const forkRepo = { json: { parent: { owner: { login: "o" } }, default_branch: "main" } };
  // basehead is "<parent-owner>:<branch>...<branch>", owner and branch each URL-encoded.
  const compare = (branch: string) => `GET ${FORK}/compare/o:${branch}...${branch}`;
  const posts = (calls: { init: RequestInit }[]) => calls.filter((c) => c.init.method === "POST");

  it("compares the fork branch to upstream, then POSTs merge-upstream on the FORK and maps the result", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${FORK}`]: forkRepo,
      [compare("main")]: { json: { status: "behind", ahead_by: 0, behind_by: 3 } },
      [`POST ${FORK}/merge-upstream`]: {
        json: {
          message: "Successfully fetched and fast-forwarded from upstream o:main",
          merge_type: "fast-forward", base_branch: "o:main",
        },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    const r = await forge.syncFork(fork, "main", actor);
    expect(r).toEqual({
      mergeType: "fast-forward", baseBranch: "o:main",
      message: "Successfully fetched and fast-forwarded from upstream o:main",
    });
    expect(calls.map((c) => `${c.init.method ?? "GET"} ${c.url}`)).toEqual([
      `GET ${FORK}`, compare("main"), `POST ${FORK}/merge-upstream`,
    ]);
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ branch: "main" });
    // The sync is a server-side ref move on the PAT, not a commit-path write.
    for (const c of calls) expect(new Headers(c.init.headers).get("authorization")).toBe("Bearer tok123");
  });

  it("still POSTs when the branch is already level (ahead_by 0, identical)", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${FORK}`]: forkRepo,
      [compare("main")]: { json: { status: "identical", ahead_by: 0, behind_by: 0 } },
      [`POST ${FORK}/merge-upstream`]: {
        json: { message: "This branch is not behind the upstream o:main.", merge_type: "none", base_branch: "o:main" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    expect((await forge.syncFork(fork, "main", actor)).mergeType).toBe("none");
    expect(posts(calls)).toHaveLength(1);
  });

  // The merge-upstream endpoint MERGES a fork branch whose own commits apply
  // cleanly (a bot-authored, unsigned merge commit) and refuses only a
  // conflicting one — so the proxy must refuse any ahead branch itself,
  // before the write, or the by-construction authorship property is lost.
  it("refuses a branch that is ahead of upstream as fork_diverged, with ZERO POSTs", async () => {
    for (const status of ["ahead", "diverged"]) {
      const { fn, calls } = makeFetch({
        [`GET ${FORK}`]: forkRepo,
        [compare("feat")]: { json: { status, ahead_by: 2, behind_by: status === "diverged" ? 5 : 0 } },
        [`POST ${FORK}/merge-upstream`]: { json: { merge_type: "merge", base_branch: "o:feat", message: "merged" } },
      });
      const forge = new GithubForge({ credentials, fetch: fn });
      await expect(forge.syncFork(fork, "feat", actor), status).rejects.toMatchObject({
        kind: "fork_diverged", upstream: 409,
        message: expect.stringContaining("critical-agent-zero/r@feat"),
      });
      expect(posts(calls), status).toHaveLength(0);
    }
  });

  it("refuses a repo with no parent (not a fork) as a clear invalid 422, with ZERO POSTs", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${FORK}`]: { json: { default_branch: "main" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.syncFork(fork, "main", actor)).rejects.toMatchObject({
      kind: "invalid", upstream: 422, message: expect.stringMatching(/not a fork/),
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses a merge_type it does not know, as an upstream error, instead of repeating it", async () => {
    const { fn } = makeFetch({
      [`GET ${FORK}`]: forkRepo,
      [compare("main")]: { json: { status: "behind", ahead_by: 0, behind_by: 1 } },
      [`POST ${FORK}/merge-upstream`]: {
        json: { message: "ok", merge_type: "rebase<script>", base_branch: "o:main" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.syncFork(fork, "main", actor)).rejects.toMatchObject({
      kind: "invalid", upstream: 502, message: expect.stringMatching(/unrecognised merge_type/),
    });
  });

  it("maps a compare 404 (branch missing on fork or upstream) to a clear invalid 422", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${FORK}`]: forkRepo,
      [compare("nope")]: { status: 404, json: { message: "Not Found" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.syncFork(fork, "nope", actor)).rejects.toMatchObject({
      kind: "invalid", upstream: 422, message: expect.stringMatching(/does not exist/),
    });
    expect(posts(calls)).toHaveLength(0);
  });

  it("encodes the branch and parent owner into one compare path unit", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${FORK}`]: forkRepo,
      [`GET ${FORK}/compare/o:feat%2Fx...feat%2Fx`]: { json: { status: "behind", ahead_by: 0, behind_by: 1 } },
      [`POST ${FORK}/merge-upstream`]: {
        json: { message: "ok", merge_type: "fast-forward", base_branch: "o:feat/x" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await forge.syncFork(fork, "feat/x", actor);
    expect(calls[1]!.url).toBe(`${FORK}/compare/o:feat%2Fx...feat%2Fx`);
  });

  // The pre-check can race a commit that lands on the fork branch between
  // the compare and the merge; the mapping stays as the backstop.
  it("maps a merge-upstream 409 (conflicting commits, pre-check raced) to fork_diverged", async () => {
    const { fn } = makeFetch({
      [`GET ${FORK}`]: forkRepo,
      [compare("feat")]: { json: { status: "behind", ahead_by: 0, behind_by: 1 } },
      [`POST ${FORK}/merge-upstream`]: { status: 409, json: { message: "There are merge conflicts" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.syncFork(fork, "feat", actor)).rejects.toMatchObject({
      kind: "fork_diverged", upstream: 409,
      message: expect.stringContaining("critical-agent-zero/r@feat"),
    });
  });

  it("passes a merge_type 'merge' (pre-check raced a clean divergence) through so the ledger records it", async () => {
    const { fn } = makeFetch({
      [`GET ${FORK}`]: forkRepo,
      [compare("feat")]: { json: { status: "behind", ahead_by: 0, behind_by: 1 } },
      [`POST ${FORK}/merge-upstream`]: {
        json: { message: "Successfully fetched and merged from upstream o:feat", merge_type: "merge", base_branch: "o:feat" },
      },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    expect((await forge.syncFork(fork, "feat", actor)).mergeType).toBe("merge");
  });

  it("maps a merge-upstream 422 (branch missing / not a fork) to a clear invalid", async () => {
    const { fn } = makeFetch({
      [`GET ${FORK}`]: forkRepo,
      [compare("nope")]: { json: { status: "behind", ahead_by: 0, behind_by: 1 } },
      [`POST ${FORK}/merge-upstream`]: { status: 422, json: { message: "Validation Failed" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.syncFork(fork, "nope", actor)).rejects.toMatchObject({
      kind: "invalid", upstream: 422,
      message: expect.stringMatching(/not a fork/),
    });
  });

  it("keeps a 422 that mapError read as non_fast_forward on that kind (not relabelled invalid)", async () => {
    const { fn } = makeFetch({
      [`GET ${FORK}`]: forkRepo,
      [compare("main")]: { json: { status: "behind", ahead_by: 0, behind_by: 1 } },
      [`POST ${FORK}/merge-upstream`]: { status: 422, json: { message: "Update is not a fast forward" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.syncFork(fork, "main", actor)).rejects.toMatchObject({
      kind: "non_fast_forward", upstream: 422,
    });
  });

  it("leaves other upstream failures on the generic mapping", async () => {
    const { fn } = makeFetch({
      [`GET ${FORK}`]: { status: 404, json: { message: "Not Found" } },
    });
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.syncFork(fork, "main", actor)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses a multi-segment owner/repo before any request", async () => {
    const { fn, calls } = makeFetch({});
    const forge = new GithubForge({ credentials, fetch: fn });
    await expect(forge.syncFork({ owner: "critical-agent-zero", name: "r/../../o/src" }, "main", actor))
      .rejects.toMatchObject({ kind: "invalid" });
    expect(calls).toHaveLength(0);
  });
});

describe("GithubForge commit-path vs PAT-path token selection (issue #120)", () => {
  // A store that hands a DIFFERENT token to the commit write-path (App
  // installation token) than to every other call (PAT), so we can assert
  // per-call which credential authenticated the request. Fresh per test so
  // the spies don't accumulate calls across cases.
  const makeSplit = (): CredentialStore => ({
    resolve: vi.fn(async () => "PAT"),
    resolveCommitToken: vi.fn(async () => "INSTALL"),
    resolveCommitSigner: vi.fn(async () => undefined),
  });

  const auth = (call: { init: RequestInit }) =>
    new Headers(call.init.headers).get("authorization");

  it("signs the commit write-path (blob/tree/commit/ref) with the installation token", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "head1" } } },
      [`GET ${B}/git/commits/head1`]: { json: { tree: { sha: "tree0" } } },
      [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
      [`POST ${B}/git/commits`]: { json: { sha: "c1", html_url: "u" } },
      [`PATCH ${B}/git/refs/heads/main`]: { json: {} },
      [`POST ${B}/git/blobs`]: { json: { sha: "b1" } },
    });
    const split = makeSplit();
    const forge = new GithubForge({ credentials: split, fetch: fn });
    await forge.putBlob({ owner: "o", name: "r" }, { contentBase64: "QQ==" }, actor);
    await forge.createCommit({ owner: "o", name: "r" },
      { branch: "main", message: "m", files: [{ path: "a", content: "A" }] }, actor);
    // Every git-data write/read in the commit flow used the installation token.
    for (const c of calls) expect(auth(c)).toBe("Bearer INSTALL");
    expect((split.resolve as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("keeps fork, sync, PR-open, comment, and repo reads on the PAT", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${B}`]: { json: { default_branch: "main", parent: { owner: { login: "up" } } } },
      [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "abc" } } },
      [`GET ${B}/compare/up:main...main`]: { json: { status: "behind", ahead_by: 0, behind_by: 1 } },
      [`POST ${B}/merge-upstream`]: { json: { merge_type: "fast-forward", base_branch: "up:main", message: "ok" } },
      [`POST ${B}/forks`]: { json: { name: "r", owner: { login: "x" }, default_branch: "main" } },
      [`POST ${B}/pulls`]: { json: { number: 1, html_url: "u" } },
      [`POST ${B}/issues/7/comments`]: { json: { id: 1, html_url: "u" } },
    });
    const split = makeSplit();
    const forge = new GithubForge({ credentials: split, fetch: fn });
    await forge.getRepo({ owner: "o", name: "r" }, actor);
    await forge.fork({ owner: "o", name: "r" }, actor);
    await forge.syncFork({ owner: "o", name: "r" }, "main", actor);
    await forge.openPullRequest({ owner: "o", name: "r" },
      { head: "f", base: "main", title: "t", body: "b" }, actor);
    await forge.comment({ owner: "o", name: "r" }, 7, "hi", actor);
    for (const c of calls) expect(auth(c)).toBe("Bearer PAT");
    expect((split.resolveCommitToken as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("GithubForge commit signing (issue #120)", () => {
  const NOW_MS = 1_758_709_800_000; // fixed instant → unixSec 1758709800 = 2025-09-24T10:30:00Z
  const UNIX = Math.floor(NOW_MS / 1000);
  const botCommitter = {
    name: "critical-agent-zero",
    email: "299802836+critical-agent-zero@users.noreply.github.com",
  };
  const signer: CommitSigner = {
    committer: botCommitter,
    sign: (buf) => sshSign(buf, FIX_KEY),
  };
  const signingCreds: CredentialStore = {
    resolve: async () => "tok",
    resolveCommitToken: async () => "commit-tok",
    resolveCommitSigner: async () => signer,
  };
  const routes = {
    [`GET ${B}/git/ref/heads/main`]: { json: { object: { sha: "head1" } } },
    [`GET ${B}/git/commits/head1`]: { json: { tree: { sha: "tree0" } } },
    [`POST ${B}/git/trees`]: { json: { sha: "tree1" } },
    [`POST ${B}/git/commits`]: { json: { sha: "c1", html_url: "u" } },
    [`PATCH ${B}/git/refs/heads/main`]: { json: {} },
  };
  const commitBody = (calls: { url: string; init: RequestInit }[]) =>
    JSON.parse(calls.find((c) => c.url.endsWith("/git/commits") && c.init.method === "POST")!
      .init.body as string);

  it("sets committer=bot, keeps author=agent, and both dates to one UTC instant", async () => {
    const { fn, calls } = makeFetch(routes);
    const forge = new GithubForge({ credentials: signingCreds, fetch: fn, now: () => NOW_MS });
    await forge.createCommit({ owner: "o", name: "r" },
      { branch: "main", message: "feat: signed", files: [{ path: "a", content: "A" }] }, actor);
    const body = commitBody(calls);
    expect(body.author).toEqual({ name: actor.name, email: actor.email, date: "2025-09-24T10:30:00Z" });
    expect(body.committer).toEqual({ ...botCommitter, date: "2025-09-24T10:30:00Z" });
    // one captured instant → author.date === committer.date, both integer-second UTC 'Z'
    expect(body.author.date).toBe(body.committer.date);
    expect(Math.floor(Date.parse(body.author.date) / 1000)).toBe(UNIX);
  });

  it("attaches an SSH signature over EXACTLY the bytes GitHub reconstructs from the body (GOLD)", async () => {
    const { fn, calls } = makeFetch(routes);
    const forge = new GithubForge({ credentials: signingCreds, fetch: fn, now: () => NOW_MS });
    await forge.createCommit({ owner: "o", name: "r" },
      { branch: "main", message: "feat: signed", files: [{ path: "a", content: "A" }] }, actor);
    const body = commitBody(calls);
    expect(body.signature).toMatch(/^-----BEGIN SSH SIGNATURE-----\n/);
    // The message the proxy SENDS must end in a newline, so GitHub's verbatim
    // reconstruction equals git's object convention (and the signed bytes).
    expect(body.message.endsWith("\n")).toBe(true);
    // Rebuild the commit object exactly as GitHub does from the request fields
    // (author.date → unixSec + "+0000"; verbatim message) and assert the proxy
    // signed those very bytes — the end-to-end verified=true guarantee.
    const unixSec = Math.floor(Date.parse(body.author.date) / 1000);
    const reconstructed = Buffer.from(
      `tree ${body.tree}\n`
      + `parent ${body.parents[0]}\n`
      + `author ${body.author.name} <${body.author.email}> ${unixSec} +0000\n`
      + `committer ${body.committer.name} <${body.committer.email}> ${unixSec} +0000\n`
      + "\n"
      + body.message,
      "utf8",
    );
    expect(body.signature).toBe(sshSign(reconstructed, FIX_KEY));
  });

  it("uses the commit-path auth token AND signs (auth and signing are independent)", async () => {
    const { fn, calls } = makeFetch(routes);
    const forge = new GithubForge({ credentials: signingCreds, fetch: fn, now: () => NOW_MS });
    await forge.createCommit({ owner: "o", name: "r" },
      { branch: "main", message: "m", files: [{ path: "a", content: "A" }] }, actor);
    for (const c of calls) {
      expect(new Headers(c.init.headers).get("authorization")).toBe("Bearer commit-tok");
    }
  });

  it("fails closed on a partial signing config BEFORE any upstream write (creates nothing)", async () => {
    const { fn, calls } = makeFetch(routes);
    const failing: CredentialStore = {
      resolve: async () => "tok",
      resolveCommitToken: async () => "commit-tok",
      resolveCommitSigner: async () => {
        throw new ForgeError("upstream_auth", "github commit signing is partially configured");
      },
    };
    const forge = new GithubForge({ credentials: failing, fetch: fn, now: () => NOW_MS });
    await expect(forge.createCommit({ owner: "o", name: "r" },
      { branch: "main", message: "m", files: [{ path: "a", content: "A" }] }, actor))
      .rejects.toMatchObject({ kind: "upstream_auth" });
    expect(calls).toHaveLength(0); // no ref read, no tree, no commit, no ref move
  });

  it("omits committer, dates, and signature when no signer is configured (unsigned path unchanged)", async () => {
    const { fn, calls } = makeFetch(routes);
    const forge = new GithubForge({ credentials, fetch: fn, now: () => NOW_MS }); // resolveCommitSigner → undefined
    await forge.createCommit({ owner: "o", name: "r" },
      { branch: "main", message: "feat: x", files: [{ path: "a", content: "A" }] }, actor);
    const body = commitBody(calls);
    expect(body).toEqual({
      message: "feat: x", tree: "tree1", parents: ["head1"],
      author: { name: actor.name, email: actor.email },
    });
    expect(body.signature).toBeUndefined();
    expect(body.committer).toBeUndefined();
  });
});

describe("GithubForge.repoVisibility", () => {
  const vis = async (json: unknown) => {
    const { fn } = makeFetch({ [`GET ${B}`]: { json } });
    return new GithubForge({ credentials, fetch: fn })
      .repoVisibility({ owner: "o", name: "r" }, actor);
  };

  it("maps a world-readable repo to 'public'", async () => {
    expect(await vis({ private: false, visibility: "public" })).toBe("public");
    // older GHES payloads may omit `visibility`; `private: false` suffices
    expect(await vis({ private: false })).toBe("public");
  });

  it("maps private and GHES-internal repos to 'private' (fail closed)", async () => {
    expect(await vis({ private: true, visibility: "private" })).toBe("private");
    expect(await vis({ private: false, visibility: "internal" })).toBe("private");
    // a malformed payload proves nothing: not public
    expect(await vis({})).toBe("private");
  });

  it("propagates upstream errors as ForgeErrors (callers decide the fail-closed handling)", async () => {
    const { fn } = makeFetch({ [`GET ${B}`]: { status: 404, json: { message: "Not Found" } } });
    await expect(new GithubForge({ credentials, fetch: fn })
      .repoVisibility({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "not_found" });
  });
});
