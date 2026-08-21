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

  it("register sends fleet key header and returns identity", async () => {
    const fetchMock = makeFetch({ agentId: "482913", address: "482913@d" });
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fleetKey: "fk", fetch: fetchMock as never,
    });
    const id = await client.register();
    expect(id).toEqual({ agentId: "482913", address: "482913@d" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-fleet-key")).toBe("fk");
  });

  it("throws with status and body on non-2xx", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "revoked" }), { status: 403 }));
    const client = new AgentIdentityClient({
      apiUrl: "https://api.example", keypair: kp, fetch: fetchMock as never,
    });
    await expect(client.me()).rejects.toThrow(/403.*revoked/s);
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
});
