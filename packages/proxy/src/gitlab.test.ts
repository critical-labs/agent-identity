import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "./forge.js";
import { GitlabForge } from "./gitlab.js";

const credentials: CredentialStore = {
  resolve: async () => "glpat-x",
  resolveCommitToken: async () => "glpat-x",
  resolveCommitSigner: async () => undefined,
};
const actor = { name: "482913", email: "482913@agents.example" };

function makeFetch(routes: Record<string, { status?: number; json?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200 });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const P = "https://gitlab.com/api/v4/projects/o%2Fr";

describe("GitlabForge.getRepo", () => {
  it("returns default branch and head sha, using PRIVATE-TOKEN auth for the actor", async () => {
    const resolve = vi.fn(async () => "glpat-x");
    const { fn, calls } = makeFetch({
      [`GET ${P}`]: { json: { default_branch: "main" } },
      [`GET ${P}/repository/branches/main`]: { json: { commit: { id: "abc123" } } },
    });
    const forge = new GitlabForge({
      credentials: { resolve, resolveCommitToken: resolve, resolveCommitSigner: async () => undefined },
      fetch: fn,
    });
    const info = await forge.getRepo({ owner: "o", name: "r" }, actor);
    expect(info).toEqual({ defaultBranch: "main", headSha: "abc123" });
    expect(resolve).toHaveBeenCalledWith("gitlab", "482913");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("PRIVATE-TOKEN")).toBe("glpat-x");
  });

  it("maps 401 to upstream_auth and 403 to forbidden", async () => {
    const a = makeFetch({ [`GET ${P}`]: { status: 401, json: { message: "401" } } });
    await expect(new GitlabForge({ credentials, fetch: a.fn }).getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "upstream_auth" });
    const b = makeFetch({ [`GET ${P}`]: { status: 403, json: { message: "403" } } });
    await expect(new GitlabForge({ credentials, fetch: b.fn }).getRepo({ owner: "o", name: "r" }, actor))
      .rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("GitlabForge.createCommit", () => {
  it("probes file existence to choose create vs update and forces the author", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${P}/repository/branches/main`]: { json: { name: "main" } },
      [`GET ${P}/repository/files/exists.txt?ref=main`]: { json: { file_path: "exists.txt" } },
      [`GET ${P}/repository/files/new.txt?ref=main`]: { status: 404, json: { message: "404" } },
      [`POST ${P}/repository/commits`]: {
        json: { id: "sha1", web_url: "https://gitlab.com/o/r/-/commit/sha1" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, {
      branch: "main", message: "m",
      files: [{ path: "exists.txt", content: "A" }, { path: "new.txt", content: "B" }],
    }, actor);
    expect(result).toEqual({ sha: "sha1", url: "https://gitlab.com/o/r/-/commit/sha1" });
    const commitCall = calls.find((c) => c.url === `${P}/repository/commits`)!;
    expect(JSON.parse(commitCall.init.body as string)).toEqual({
      branch: "main", commit_message: "m",
      author_name: "482913", author_email: "482913@agents.example",
      actions: [
        { action: "update", file_path: "exists.txt", content: "A" },
        { action: "create", file_path: "new.txt", content: "B" },
      ],
    });
  });
});

describe("GitlabForge.createCommit branch auto-create", () => {
  const spec = { branch: "feat-x", message: "m", files: [{ path: "a.txt", content: "A" }] };

  it("creates a missing branch from the project's OWN default branch, then commits", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${P}/repository/branches/feat-x`]: { status: 404, json: { message: "404 Branch Not Found" } },
      [`GET ${P}`]: { json: { default_branch: "main" } },
      [`POST ${P}/repository/branches`]: { status: 201, json: { name: "feat-x" } },
      [`GET ${P}/repository/files/a.txt?ref=feat-x`]: { status: 404, json: { message: "404" } },
      [`POST ${P}/repository/commits`]: {
        json: { id: "sha1", web_url: "https://gitlab.com/o/r/-/commit/sha1" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, spec, actor);
    expect(result).toEqual({ sha: "sha1", url: "https://gitlab.com/o/r/-/commit/sha1" });

    const branchCreate = calls.findIndex((c) => c.url === `${P}/repository/branches` && c.init.method === "POST");
    expect(branchCreate).toBeGreaterThan(-1);
    expect(JSON.parse(calls[branchCreate]!.init.body as string)).toEqual({
      branch: "feat-x", ref: "main",
    });
    const commitPost = calls.findIndex((c) => c.url === `${P}/repository/commits`);
    expect(branchCreate).toBeLessThan(commitPost);
    expect(JSON.parse(calls[commitPost]!.init.body as string).branch).toBe("feat-x");
  });

  it("falls through to committing when the branch appears between check and create", async () => {
    const { fn } = makeFetch({
      [`GET ${P}/repository/branches/feat-x`]: { status: 404, json: { message: "404 Branch Not Found" } },
      [`GET ${P}`]: { json: { default_branch: "main" } },
      [`POST ${P}/repository/branches`]: { status: 400, json: { message: "Branch already exists" } },
      [`GET ${P}/repository/files/a.txt?ref=feat-x`]: { json: { file_path: "a.txt" } },
      [`POST ${P}/repository/commits`]: {
        json: { id: "sha1", web_url: "https://gitlab.com/o/r/-/commit/sha1" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const result = await forge.createCommit({ owner: "o", name: "r" }, spec, actor);
    expect(result).toEqual({ sha: "sha1", url: "https://gitlab.com/o/r/-/commit/sha1" });
  });

  it("surfaces retryable not_found for an empty project (fresh fork still importing), writing nothing", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${P}/repository/branches/feat-x`]: { status: 404, json: { message: "404 Branch Not Found" } },
      [`GET ${P}`]: { json: { default_branch: null } },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    await expect(forge.createCommit({ owner: "o", name: "r" }, spec, actor))
      .rejects.toMatchObject({ kind: "not_found" });
    expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
  });
});

describe("GitlabForge.putBlob", () => {
  it("is unsupported — content is carried inline via commitChanges", async () => {
    const { fn, calls } = makeFetch({});
    const forge = new GitlabForge({ credentials, fetch: fn });
    await expect(forge.putBlob({ owner: "o", name: "r" }, { contentBase64: "QQ==" }, actor))
      .rejects.toMatchObject({ kind: "invalid" });
    expect(calls).toHaveLength(0);
  });
});

describe("GitlabForge.commitChanges", () => {
  it("builds create/update/delete actions with base64 content and forces the author", async () => {
    const { fn, calls } = makeFetch({
      [`GET ${P}/repository/branches/main`]: { json: { name: "main" } },
      [`GET ${P}/repository/files/exists.txt?ref=main`]: { json: { file_path: "exists.txt" } },
      [`GET ${P}/repository/files/new.bin?ref=main`]: { status: 404, json: { message: "404" } },
      [`POST ${P}/repository/commits`]: {
        json: { id: "sha1", web_url: "https://gitlab.com/o/r/-/commit/sha1" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const result = await forge.commitChanges({ owner: "o", name: "r" }, {
      branch: "main", message: "m",
      changes: [
        { path: "exists.txt", content: "QUJD" },
        { path: "new.bin", content: "REVG" },
        { path: "gone.txt", deleted: true },
      ],
    }, actor);
    expect(result).toEqual({ sha: "sha1", url: "https://gitlab.com/o/r/-/commit/sha1" });
    const commitCall = calls.find((c) => c.url === `${P}/repository/commits`)!;
    expect(JSON.parse(commitCall.init.body as string)).toEqual({
      branch: "main", commit_message: "m",
      author_name: "482913", author_email: "482913@agents.example",
      actions: [
        { action: "update", file_path: "exists.txt", content: "QUJD", encoding: "base64" },
        { action: "create", file_path: "new.bin", content: "REVG", encoding: "base64" },
        { action: "delete", file_path: "gone.txt" },
      ],
    });
  });

  it("rejects a github-style blobSha change (gitlab has no blob object)", async () => {
    const { fn } = makeFetch({
      [`GET ${P}/repository/branches/main`]: { json: { name: "main" } },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    await expect(forge.commitChanges({ owner: "o", name: "r" }, {
      branch: "main", message: "m",
      changes: [{ path: "a", blobSha: "b1" } as never],
    }, actor)).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("GitlabForge.openPullRequest and comment", () => {
  it("opens an MR (iid becomes number)", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${P}/merge_requests`]: {
        json: { iid: 4, web_url: "https://gitlab.com/o/r/-/merge_requests/4" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const pr = await forge.openPullRequest({ owner: "o", name: "r" },
      { head: "feat/x", base: "main", title: "t", body: "d" }, actor);
    expect(pr).toEqual({ number: 4, url: "https://gitlab.com/o/r/-/merge_requests/4" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      source_branch: "feat/x", target_branch: "main", title: "t", description: "d",
    });
  });

  it("opens a cross-project MR from a fork (head owner:branch) to the source", async () => {
    const FORK = "https://gitlab.com/api/v4/projects/agent-482913%2Fr";
    const { fn, calls } = makeFetch({
      [`GET ${P}`]: { json: { id: 100 } },
      [`POST ${FORK}/merge_requests`]: {
        json: { iid: 9, web_url: "https://gitlab.com/o/r/-/merge_requests/9" },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const pr = await forge.openPullRequest({ owner: "o", name: "r" },
      { head: "agent-482913:feat/x", base: "main", title: "t", body: "d" }, actor);
    expect(pr).toEqual({ number: 9, url: "https://gitlab.com/o/r/-/merge_requests/9" });
    const mrCall = calls.find((c) => c.url === `${FORK}/merge_requests`)!;
    expect(JSON.parse(mrCall.init.body as string)).toEqual({
      source_branch: "feat/x", target_branch: "main", title: "t", description: "d",
      target_project_id: 100,
    });
  });

  it("updates an MR the identity's own service account opened, carrying footers forward", async () => {
    const ATTR = "_description updated by agent 482913 via agent-identity proxy_";
    const mr = {
      iid: 4, web_url: "https://gitlab.com/o/r/-/merge_requests/4", title: "old",
      description: "old\n\n_opened by agent 482913 via agent-identity proxy_",
      author: { username: "agent-482913" },
    };
    const { fn, calls } = makeFetch({
      [`GET ${P}/merge_requests/4`]: { json: mr },
      [`PUT ${P}/merge_requests/4`]: { json: mr },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const r = await forge.updatePullRequest({ owner: "o", name: "r" }, 4,
      { body: "new" }, ATTR, actor);
    expect(r).toEqual({ number: 4, url: "https://gitlab.com/o/r/-/merge_requests/4" });
    const put = calls.find((c) => c.init.method === "PUT")!;
    expect(JSON.parse(put.init.body as string)).toEqual({
      description: `new\n\n_opened by agent 482913 via agent-identity proxy_\n${ATTR}`,
    });
  });

  it("refuses an MR another account opened, before any write", async () => {
    const mr = { iid: 4, web_url: "u", title: "t", description: "", author: { username: "agent-999" } };
    const { fn, calls } = makeFetch({
      [`GET ${P}/merge_requests/4`]: { json: mr },
      [`PUT ${P}/merge_requests/4`]: { json: mr },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    await expect(forge.updatePullRequest({ owner: "o", name: "r" }, 4, { title: "x" }, "_a by agent 1 via agent-identity proxy_", actor))
      .rejects.toMatchObject({ kind: "forbidden" });
    expect(calls.some((c) => c.init.method === "PUT")).toBe(false);
  });

  describe("issues (#144)", () => {
    const LABELS = `GET ${P}/labels?per_page=100&page=1`;
    const issue = (over: Record<string, unknown> = {}) => ({
      iid: 21, web_url: "https://gitlab.com/o/r/-/issues/21", state: "opened", labels: [],
      description: "old\n\n_opened by agent 482913 via agent-identity proxy_",
      author: { username: "agent-482913" }, ...over,
    });

    it("opens an issue, resolving labels, assignee usernames, and the milestone iid", async () => {
      const { fn, calls } = makeFetch({
        [LABELS]: { json: [{ name: "Bug" }, { name: "follow-up" }] },
        "GET https://gitlab.com/api/v4/users?username=mc": { json: [{ id: 5, username: "mc" }] },
        [`GET ${P}/milestones?iids[]=3`]: { json: [{ id: 77, iid: 3 }] },
        [`POST ${P}/issues`]: {
          json: issue({ labels: ["Bug", "follow-up"], assignees: [{ username: "mc" }], milestone: { iid: 3 } }),
        },
      });
      const forge = new GitlabForge({ credentials, fetch: fn });
      const r = await forge.openIssue({ owner: "o", name: "r" }, {
        title: "t", body: "b", labels: ["bug", "follow-up"], assignees: ["mc"], milestone: 3,
      }, actor);
      expect(r).toEqual({
        number: 21, url: "https://gitlab.com/o/r/-/issues/21", state: "open", labels: ["Bug", "follow-up"],
      });
      const post = calls.find((c) => c.init.method === "POST")!;
      expect(JSON.parse(post.init.body as string)).toEqual({
        title: "t", description: "b", labels: "Bug,follow-up", assignee_ids: [5], milestone_id: 77,
      });
    });

    it("refuses an unknown label, assignee, or milestone before any write", async () => {
      const { fn, calls } = makeFetch({
        [LABELS]: { json: [{ name: "bug" }] },
        "GET https://gitlab.com/api/v4/users?username=ghost": { json: [] },
        [`GET ${P}/milestones?iids[]=9`]: { json: [] },
        [`POST ${P}/issues`]: { json: issue() },
      });
      const forge = new GitlabForge({ credentials, fetch: fn });
      const ref = { owner: "o", name: "r" };
      await expect(forge.openIssue(ref, { title: "t", body: "b", labels: ["nope"] }, actor))
        .rejects.toMatchObject({ kind: "invalid", message: expect.stringMatching(/"nope".*never creates/) });
      await expect(forge.openIssue(ref, { title: "t", body: "b", assignees: ["ghost"] }, actor))
        .rejects.toMatchObject({ kind: "invalid", message: expect.stringContaining("ghost") });
      await expect(forge.openIssue(ref, { title: "t", body: "b", milestone: 9 }, actor))
        .rejects.toMatchObject({ kind: "invalid", message: expect.stringContaining("9") });
      expect(calls.some((c) => c.init.method === "POST")).toBe(false);
    });

    it("updates an issue its own service account opened: footers carried, state as state_event", async () => {
      const ATTR = "_description updated by agent 482913 via agent-identity proxy_";
      const { fn, calls } = makeFetch({
        [`GET ${P}/issues/21`]: { json: issue() },
        [`PUT ${P}/issues/21`]: { json: issue({ state: "closed" }) },
      });
      const forge = new GitlabForge({ credentials, fetch: fn });
      const r = await forge.updateIssue({ owner: "o", name: "r" }, 21,
        { body: "new", labels: [], state: "closed" }, ATTR, actor);
      expect(r).toEqual({
        number: 21, url: "https://gitlab.com/o/r/-/issues/21", state: "closed", labels: [],
      });
      const put = calls.find((c) => c.init.method === "PUT")!;
      expect(JSON.parse(put.init.body as string)).toEqual({
        description: `new\n\n_opened by agent 482913 via agent-identity proxy_\n${ATTR}`,
        labels: "",
        state_event: "close",
      });
    });

    it("warns when gitlab silently drops labels, assignees, or the milestone (role below Planner/Reporter)", async () => {
      const { fn } = makeFetch({
        [LABELS]: { json: [{ name: "bug" }] },
        "GET https://gitlab.com/api/v4/users?username=mc": { json: [{ id: 5, username: "mc" }] },
        [`GET ${P}/milestones?iids[]=3`]: { json: [{ id: 77, iid: 3 }] },
        [`POST ${P}/issues`]: { json: issue({ labels: [], assignees: [], milestone: null }) },
      });
      const forge = new GitlabForge({ credentials, fetch: fn });
      const r = await forge.openIssue({ owner: "o", name: "r" },
        { title: "t", body: "b", labels: ["bug"], assignees: ["mc"], milestone: 3 }, actor);
      expect(r.warning).toMatch(/gitlab accepted the write but did not apply/);
      expect(r.warning).toMatch(/labels bug/);
      expect(r.warning).toMatch(/assignees mc/);
      expect(r.warning).toMatch(/milestone 3/);
    });

    it("gives no warning when gitlab applied everything, and warns when a label clear did not take", async () => {
      const { fn } = makeFetch({
        [LABELS]: { json: [{ name: "bug" }] },
        "GET https://gitlab.com/api/v4/users?username=mc": { json: [{ id: 5, username: "mc" }] },
        [`POST ${P}/issues`]: { json: issue({ labels: ["bug"], assignees: [{ username: "MC" }] }) },
        [`GET ${P}/issues/21`]: { json: issue({ labels: ["bug"] }) },
        [`PUT ${P}/issues/21`]: { json: issue({ labels: ["bug"] }) },
      });
      const forge = new GitlabForge({ credentials, fetch: fn });
      const ok = await forge.openIssue({ owner: "o", name: "r" },
        { title: "t", body: "b", labels: ["bug"], assignees: ["mc"] }, actor);
      expect(ok.warning).toBeUndefined();
      const r = await forge.updateIssue({ owner: "o", name: "r" }, 21, { labels: [] },
        "_a by agent 1 via agent-identity proxy_", actor);
      expect(r.warning).toMatch(/did not remove labels bug/);
    });

    it("refuses an issue another account opened, before any write", async () => {
      const { fn, calls } = makeFetch({
        [`GET ${P}/issues/21`]: { json: issue({ author: { username: "agent-999" } }) },
        [`PUT ${P}/issues/21`]: { json: issue() },
      });
      const forge = new GitlabForge({ credentials, fetch: fn });
      await expect(forge.updateIssue({ owner: "o", name: "r" }, 21, { state: "open" },
        "_a by agent 1 via agent-identity proxy_", actor))
        .rejects.toMatchObject({ kind: "forbidden" });
      expect(calls.some((c) => c.init.method === "PUT")).toBe(false);
    });
  });

  it("comments as an issue note with a constructed url", async () => {
    const { fn } = makeFetch({
      [`POST ${P}/issues/12/notes`]: { json: { id: 55 } },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const c = await forge.comment({ owner: "o", name: "r" }, 12, "hi", actor);
    expect(c).toEqual({ id: 55, url: "https://gitlab.com/o/r/-/issues/12#note_55" });
  });
});

describe("GitlabForge.fork", () => {
  it("forks into the service-account namespace and returns fork coordinates", async () => {
    const { fn, calls } = makeFetch({
      [`POST ${P}/fork`]: {
        json: { path: "r", default_branch: "main", namespace: { full_path: "agent-482913" } },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const fork = await forge.fork({ owner: "o", name: "r" }, actor);
    expect(fork).toEqual({ owner: "agent-482913", repo: "r", defaultBranch: "main" });
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("is idempotent: a 409 (already forked) returns the existing fork", async () => {
    const FORK = "https://gitlab.com/api/v4/projects/agent-482913%2Fr";
    const { fn } = makeFetch({
      [`POST ${P}/fork`]: { status: 409, json: { message: "already forked" } },
      [`GET ${FORK}`]: {
        json: { path: "r", default_branch: "main", namespace: { full_path: "agent-482913" } },
      },
    });
    const forge = new GitlabForge({ credentials, fetch: fn });
    const fork = await forge.fork({ owner: "o", name: "r" }, actor);
    expect(fork).toEqual({ owner: "agent-482913", repo: "r", defaultBranch: "main" });
  });
});

describe("GitlabForge.syncFork", () => {
  it("is unsupported: GitLab has no merge-upstream, and per-identity forks are re-created instead", async () => {
    const { fn, calls } = makeFetch({});
    const forge = new GitlabForge({ credentials, fetch: fn });
    await expect(forge.syncFork({ owner: "agent-482913", name: "r" }, "main", actor))
      .rejects.toMatchObject({ kind: "invalid", upstream: 400, message: expect.stringContaining("re-fork") });
    expect(calls).toHaveLength(0);
  });
});

describe("GitlabForge.repoVisibility", () => {
  const vis = async (json: unknown) => {
    const { fn } = makeFetch({ [`GET ${P}`]: { json } });
    return new GitlabForge({ credentials, fetch: fn })
      .repoVisibility({ owner: "o", name: "r" }, actor);
  };

  it("maps only visibility 'public' to 'public'", async () => {
    expect(await vis({ visibility: "public" })).toBe("public");
  });

  it("maps 'internal', 'private', and missing visibility to 'private' (fail closed)", async () => {
    expect(await vis({ visibility: "internal" })).toBe("private");
    expect(await vis({ visibility: "private" })).toBe("private");
    expect(await vis({})).toBe("private");
  });
});
