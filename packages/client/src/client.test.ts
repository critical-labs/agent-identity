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
