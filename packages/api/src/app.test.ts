import { canonicalString, generateKeypair, sign } from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "./app.js";

const kp = generateKeypair();

function signed(method: string, path: string, body = "") {
  const timestamp = new Date().toISOString();
  return {
    method,
    body: body || undefined,
    headers: {
      "x-agent-key": kp.publicKeySpkiBase64,
      "x-agent-timestamp": timestamp,
      "x-agent-signature": sign(canonicalString(method, path, timestamp, body), kp.privateKeyPem),
      ...(body ? { "content-type": "application/json" } : {}),
    },
  };
}

const agent = { agentId: "482913", address: "482913@d", status: "active" as const, publicKey: kp.publicKeySpkiBase64, createdAt: "t" };

function makeDeps(overrides: Record<string, unknown> = {}): Deps {
  return {
    agents: {
      getByFingerprint: vi.fn(async () => agent),
      register: vi.fn(async () => ({ agentId: "482913", address: "482913@d" })),
      verifyFleetKey: vi.fn(async () => true),
      ...overrides,
    } as never,
    emails: {
      listEmails: vi.fn(async () => ({ emails: [] })),
      getEmail: vi.fn(async () => undefined),
      ...overrides,
    } as never,
    readBody: vi.fn(async () => ({ text: "overflow", html: undefined, links: [] })),
    fleetKeyRequired: true,
  };
}

describe("app", () => {
  it("POST /register verifies fleet key and registers", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const req = signed("POST", "/register");
    const res = await app.request("/register", {
      ...req, headers: { ...req.headers, "x-fleet-key": "fk" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentId: "482913", address: "482913@d" });
  });

  it("POST /register without fleet key is 403", async () => {
    const deps = makeDeps({ verifyFleetKey: vi.fn(async () => false) as never });
    const app = createApp(deps);
    const res = await app.request("/register", signed("POST", "/register"));
    expect(res.status).toBe(403);
  });

  it("GET /me returns caller identity", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/me", signed("GET", "/me"));
    expect(await res.json()).toEqual({ agentId: "482913", address: "482913@d" });
  });

  it("GET /emails passes since/limit and scopes to caller", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const path = "/emails?since=2026-07-01T00%3A00%3A00Z&limit=5";
    const res = await app.request(path, signed("GET", path));
    expect(res.status).toBe(200);
    expect(deps.emails.listEmails).toHaveBeenCalledWith("482913", {
      since: "2026-07-01T00:00:00Z", limit: 5, cursor: undefined,
    });
  });

  it("GET /emails/:id 404s on missing/foreign email", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/emails/01ABC", signed("GET", "/emails/01ABC"));
    expect(res.status).toBe(404);
  });

  it("GET /emails/:id reads through bodyS3Key overflow", async () => {
    const deps = makeDeps({
      getEmail: vi.fn(async () => ({
        id: "01ABC", from: "a", subject: "s", receivedAt: "t",
        text: "", links: [], bodyS3Key: "bodies/482913/01ABC.json",
      })) as never,
    });
    const app = createApp(deps);
    const res = await app.request("/emails/01ABC", signed("GET", "/emails/01ABC"));
    const body = await res.json();
    expect(body.text).toBe("overflow");
    expect(deps.readBody).toHaveBeenCalledWith("bodies/482913/01ABC.json");
  });
});
