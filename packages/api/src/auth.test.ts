import { canonicalString, fingerprint, generateKeypair, sign } from "@agent-identity/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { signatureAuth } from "./auth.js";
import type { AgentsRepo } from "./db/agents.js";

function makeApp(repo: Partial<AgentsRepo>) {
  const app = new Hono();
  app.use("*", signatureAuth(repo as AgentsRepo));
  app.get("/me", (c) => c.json(c.get("agent" as never)));
  return app;
}

function signedHeaders(kp: ReturnType<typeof generateKeypair>, path: string, ts?: string) {
  const timestamp = ts ?? new Date().toISOString();
  return {
    "x-agent-key": kp.publicKeySpkiBase64,
    "x-agent-timestamp": timestamp,
    "x-agent-signature": sign(canonicalString("GET", path, timestamp, ""), kp.privateKeyPem),
  };
}

describe("signatureAuth", () => {
  const kp = generateKeypair();
  const fp = fingerprint(kp.publicKeySpkiBase64);
  const agent = { agentId: "1", address: "1@d", status: "active", publicKey: kp.publicKeySpkiBase64 };

  it("accepts a valid signature for an active agent", async () => {
    const app = makeApp({ getByFingerprint: vi.fn(async (f) => (f === fp ? agent : undefined)) as never });
    const res = await app.request("/me", { headers: signedHeaders(kp, "/me") });
    expect(res.status).toBe(200);
  });

  it("rejects bad signature with 401", async () => {
    const app = makeApp({ getByFingerprint: vi.fn(async () => agent) as never });
    const h = signedHeaders(kp, "/other-path");
    const res = await app.request("/me", { headers: h });
    expect(res.status).toBe(401);
  });

  it("rejects stale timestamp with 401", async () => {
    const app = makeApp({ getByFingerprint: vi.fn(async () => agent) as never });
    const res = await app.request("/me", {
      headers: signedHeaders(kp, "/me", "2020-01-01T00:00:00.000Z"),
    });
    expect(res.status).toBe(401);
  });

  it("rejects malformed timestamp with 401 even when the signature over it is valid", async () => {
    const app = makeApp({ getByFingerprint: vi.fn(async () => agent) as never });
    const res = await app.request("/me", { headers: signedHeaders(kp, "/me", "garbage") });
    expect(res.status).toBe(401);
  });

  it("rejects revoked agent with 403", async () => {
    const app = makeApp({
      getByFingerprint: vi.fn(async () => ({ ...agent, status: "revoked" })) as never,
    });
    const res = await app.request("/me", { headers: signedHeaders(kp, "/me") });
    expect(res.status).toBe(403);
  });

  it("rejects unknown key with 401 (except /register, which passes through)", async () => {
    const app = makeApp({ getByFingerprint: vi.fn(async () => undefined) as never });
    const res = await app.request("/me", { headers: signedHeaders(kp, "/me") });
    expect(res.status).toBe(401);
  });
});
