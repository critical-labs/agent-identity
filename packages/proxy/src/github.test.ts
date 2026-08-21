import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "./forge.js";
import { GithubForge } from "./github.js";

const credentials: CredentialStore = { resolve: async () => "tok123" };
const actor = { name: "482913", email: "482913@agents.example" };

/** fetch fake: responds per "METHOD url" from a routing table; records calls. */
function makeFetch(routes: Record<string, { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const route = routes[key];
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
    const forge = new GithubForge({ credentials: { resolve }, fetch: fn });
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
