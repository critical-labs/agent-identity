import { canonicalString, generateKeypair, verify } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentIdentityClient } from "./client.js";

const kp = generateKeypair();

function makeFetch(response: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
}

describe("AgentIdentityClient", () => {
  it("signs GET requests verifiably (path includes query)", async () => {
    const fetchMock = makeFetch({ emails: [] });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await client.listEmails({ limit: 5 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/emails?limit=5");
    const h = new Headers(init.headers);
    const msg = canonicalString("GET", "/emails?limit=5", h.get("x-agent-timestamp")!, "");
    expect(verify(msg, h.get("x-agent-signature")!, kp.publicKeySpkiBase64)).toBe(true);
  });

  it("listEmails threads the opt-in flags as query params", async () => {
    const fetchMock = makeFetch({ emails: [] });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await client.listEmails({ includeUnsolicited: true, includeUnauthenticated: true });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example/emails?includeUnsolicited=true&includeUnauthenticated=true");

    await client.listEmails({});
    const [url2] = fetchMock.mock.calls[1] as unknown as [string];
    expect(url2).toBe("https://api.example/emails");
  });

  it("register sends fleet key header and returns identity", async () => {
    const fetchMock = makeFetch({ agentId: "482913", address: "482913@d" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fleetKey: "fk", fetch: fetchMock as never,
    });
    const id = await client.register();
    expect(id).toEqual({ agentId: "482913", address: "482913@d" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-fleet-key")).toBe("fk");
    expect(init.body).toBeUndefined(); // plain register: unchanged wire shape
  });

  it("register passes requestedCapabilities in the signed body and returns granted capabilities", async () => {
    const fetchMock = makeFetch({
      agentId: "482913", address: "482913@d", capabilities: ["github"],
    });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fleetKey: "fk", fetch: fetchMock as never,
    });
    const id = await client.register({ requestedCapabilities: ["github"] });
    expect(id).toEqual({ agentId: "482913", address: "482913@d", capabilities: ["github"] });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({ requestedCapabilities: ["github"] });
    const h = new Headers(init.headers);
    const msg = canonicalString("POST", "/register", h.get("x-agent-timestamp")!, body);
    expect(verify(msg, h.get("x-agent-signature")!, kp.publicKeySpkiBase64)).toBe(true);
  });

  it("throws with status and body on non-2xx", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "revoked" }), { status: 403 }));
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await expect(client.me()).rejects.toThrow(/403.*revoked/s);
  });

  it("retries a 429 with backoff and succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("throttled", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ agentId: "482913" }), { status: 200 }));
    const sleep = vi.fn(async (_ms: number) => {});
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never, sleep,
    });
    await expect(client.me()).resolves.toEqual({ agentId: "482913" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    const delay = sleep.mock.calls[0]![0] as number;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(2000);
  });

  it("honors Retry-After (seconds) on a 429", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("throttled", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const sleep = vi.fn(async (_ms: number) => {});
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never, sleep,
    });
    await client.me();
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("drains the discarded response body before retrying a 429 (releases the socket)", async () => {
    const throttled = new Response("throttled", { status: 429 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(new Response(JSON.stringify({ agentId: "482913" }), { status: 200 }));
    const sleep = vi.fn(async (_ms: number) => {});
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never, sleep,
    });
    await client.me();
    // The retried response's body stream was consumed (cancelled), so undici
    // can return the connection to the pool instead of pinning it.
    expect(throttled.bodyUsed).toBe(true);
  });

  it("gives up after two retries on persistent 429", async () => {
    const fetchMock = vi.fn(async () => new Response("throttled", { status: 429 }));
    const sleep = vi.fn(async (_ms: number) => {});
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never, sleep,
    });
    await expect(client.me()).rejects.toThrow(/API 429/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-429 errors", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const sleep = vi.fn(async (_ms: number) => {});
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never, sleep,
    });
    await expect(client.me()).rejects.toThrow(/API 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("forge methods", () => {
  it("forgeCommit posts a signed body to the service path", async () => {
    const fetchMock = makeFetch({ sha: "c1", url: "u" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const result = await client.forgeCommit("github",
      { owner: "o", name: "r" },
      { branch: "main", message: "m", files: [{ path: "f", content: "x" }] });
    expect(result).toEqual({ sha: "c1", url: "u" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/forge/github/commit");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({
      owner: "o", repo: "r", branch: "main", message: "m",
      files: [{ path: "f", content: "x" }],
    });
    const h = new Headers(init.headers);
    const msg = canonicalString("POST", "/forge/github/commit", h.get("x-agent-timestamp")!, body);
    expect(verify(msg, h.get("x-agent-signature")!, kp.publicKeySpkiBase64)).toBe(true);
  });

  it("forgePutBlob posts the base64 content to the blob path", async () => {
    const fetchMock = makeFetch({ sha: "blob1" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const res = await client.forgePutBlob("github", { owner: "o", name: "r" }, "QUJD");
    expect(res).toEqual({ sha: "blob1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/forge/github/blob");
    expect(JSON.parse(init.body as string)).toEqual({ owner: "o", repo: "r", contentBase64: "QUJD" });
  });

  it("forgeCommitChanges posts the changes to the commit-changes path", async () => {
    const fetchMock = makeFetch({ sha: "c1", url: "u" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const res = await client.forgeCommitChanges("github", { owner: "o", name: "r" }, {
      branch: "feat", message: "m",
      changes: [{ path: "a", blobSha: "b1" }, { path: "gone", deleted: true }],
    });
    expect(res).toEqual({ sha: "c1", url: "u" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/forge/github/commit-changes");
    expect(JSON.parse(init.body as string)).toEqual({
      owner: "o", repo: "r", branch: "feat", message: "m",
      changes: [{ path: "a", blobSha: "b1" }, { path: "gone", deleted: true }],
    });
  });

  it("forgeRepo GETs the repo info path", async () => {
    const fetchMock = makeFetch({ defaultBranch: "main", headSha: "abc" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const info = await client.forgeRepo("github", { owner: "o", name: "r" });
    expect(info).toEqual({ defaultBranch: "main", headSha: "abc" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example/forge/github/repo/o/r");
  });

  it("forgeOpenPr and forgeComment post their bodies", async () => {
    const fetchMock = makeFetch({ number: 1, url: "u" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await client.forgeOpenPr("github", { owner: "o", name: "r" },
      { head: "h", base: "b", title: "t", body: "d" });
    await client.forgeComment("github", { owner: "o", name: "r" }, 3, "hi");
    const [url1, init1] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url2, init2] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url1).toBe("https://api.example/forge/github/pr");
    expect(JSON.parse(init1.body as string)).toEqual({
      owner: "o", repo: "r", head: "h", base: "b", title: "t", body: "d",
    });
    expect(url2).toBe("https://api.example/forge/github/comment");
    expect(JSON.parse(init2.body as string)).toEqual({
      owner: "o", repo: "r", issue: 3, body: "hi",
    });
  });

  it("forgeProvision posts to the provision path", async () => {
    const fetchMock = makeFetch({ username: "agent-482913", email: "482913@d" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const r = await client.forgeProvision("gitlab");
    expect(r).toEqual({ username: "agent-482913", email: "482913@d" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example/forge/gitlab/provision");
  });

  it("forgeFork posts to the fork path", async () => {
    const fetchMock = makeFetch({ owner: "fork-acct", repo: "r", defaultBranch: "main" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const r = await client.forgeFork("github", { owner: "o", name: "r" });
    expect(r).toEqual({ owner: "fork-acct", repo: "r", defaultBranch: "main" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/forge/github/fork");
    expect(JSON.parse(init.body as string)).toEqual({ owner: "o", repo: "r" });
  });

  it("forgeSync posts to the sync path, sending branch only when given", async () => {
    const result = { mergeType: "fast-forward", baseBranch: "o:main", message: "ok" };
    const fetchMock = makeFetch(result);
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const r = await client.forgeSync("github", { owner: "fork-acct", name: "r" }, "main");
    expect(r).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/forge/github/sync");
    expect(JSON.parse(init.body as string)).toEqual({ owner: "fork-acct", repo: "r", branch: "main" });

    await client.forgeSync("github", { owner: "fork-acct", name: "r" });
    const [, init2] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(init2.body as string)).toEqual({ owner: "fork-acct", repo: "r" });
  });

  it("setStatus posts a claimed status self-report", async () => {
    const fetchMock = makeFetch({ event: {} });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await client.setStatus("working", "shipping the ledger");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/activity");
    expect(JSON.parse(init.body as string)).toEqual({
      type: "status", state: "working", label: "shipping the ledger",
    });
  });

  it("reportTaskNote posts a claimed task_note self-report", async () => {
    const fetchMock = makeFetch({ event: {} });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await client.reportTaskNote("finished tests");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/activity");
    expect(JSON.parse(init.body as string)).toEqual({ type: "task_note", note: "finished tests" });
  });

  it("myActivity reads the signed own-feed with cursor params", async () => {
    const fetchMock = makeFetch({ events: [], cursor: "next" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    const r = await client.myActivity({ limit: 5, cursor: "abc" });
    expect(r).toEqual({ events: [], cursor: "next" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example/agents/me/activity?limit=5&cursor=abc");
  });

});
