import { describe, expect, it, vi } from "vitest";
import { makeTools } from "./tools.js";

function makeClient(over: Record<string, unknown> = {}) {
  return {
    register: vi.fn(async () => ({ agentId: "482913", address: "482913@d" })),
    listEmails: vi.fn(async () => ({ emails: [] })),
    getEmail: vi.fn(async () => ({ id: "01A", from: "a", subject: "s", receivedAt: "t", text: "b", links: [] })),
    ...over,
  };
}

function makeManager(client = makeClient()) {
  return {
    client: () => client,
    ensureIdentity: vi.fn(async (_require?: string[]) => ({ agentId: "482913", address: "482913@d" })),
    status: vi.fn(() => ({ held: { name: "482913", capabilities: [] }, pool: { total: 1, free: 0, freeByCapability: {} } })),
  } as never;
}

describe("mcp tools", () => {
  it("ensure_identity delegates to the manager with require", async () => {
    const mgr = makeManager();
    const tools = makeTools(mgr);
    const res = await tools.ensureIdentity({ require: ["github"] });
    expect(res).toEqual({ agentId: "482913", address: "482913@d" });
    expect((mgr as { ensureIdentity: ReturnType<typeof vi.fn> }).ensureIdentity)
      .toHaveBeenCalledWith(["github"]);
  });

  it("identity_status reports manager status", () => {
    const tools = makeTools(makeManager());
    expect(tools.identityStatus()).toEqual(
      expect.objectContaining({ held: expect.objectContaining({ name: "482913" }) }),
    );
  });

  it("wait_for_email returns first match", async () => {
    const client = makeClient({
      listEmails: vi.fn(async () => ({
        emails: [
          { id: "1", from: "spam@x", subject: "junk", receivedAt: "t" },
          { id: "2", from: "noreply@github.com", subject: "Verify your email", receivedAt: "t" },
        ],
      })),
    });
    const tools = makeTools(makeManager(client));
    const res = await tools.waitForEmail(
      { fromContains: "github", timeoutSeconds: 1 }, { pollMs: 10 },
    );
    expect(res).toEqual(expect.objectContaining({ id: "2" }));
  });

  it("wait_for_email times out cleanly (result, not throw)", async () => {
    const tools = makeTools(makeManager());
    const res = await tools.waitForEmail({ subjectContains: "never", timeoutSeconds: 0.05 }, { pollMs: 10 });
    expect(res).toEqual({ timedOut: true });
  });
});
