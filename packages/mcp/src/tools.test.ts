import { describe, expect, it, vi } from "vitest";
import { makeTools } from "./tools.js";

function makeClient(over: Record<string, unknown> = {}) {
  return {
    register: vi.fn(async () => ({ agentId: "482913", address: "482913@d" })),
    listEmails: vi.fn(async () => ({ emails: [] })),
    getEmail: vi.fn(async () => ({ id: "01A", from: "a", subject: "s", receivedAt: "t", text: "b", links: [] })),
    ...over,
  } as never;
}

describe("mcp tools", () => {
  it("ensure_identity registers and persists identity to profile", async () => {
    const save = vi.fn();
    const tools = makeTools(makeClient(), save);
    const res = await tools.ensureIdentity();
    expect(res).toEqual({ agentId: "482913", address: "482913@d" });
    expect(save).toHaveBeenCalledWith({ agentId: "482913", address: "482913@d" });
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
    const tools = makeTools(client, vi.fn());
    const res = await tools.waitForEmail(
      { fromContains: "github", timeoutSeconds: 1 }, { pollMs: 10 },
    );
    expect(res).toEqual(expect.objectContaining({ id: "2" }));
  });

  it("wait_for_email times out cleanly (result, not throw)", async () => {
    const tools = makeTools(makeClient(), vi.fn());
    const res = await tools.waitForEmail({ subjectContains: "never", timeoutSeconds: 0.05 }, { pollMs: 10 });
    expect(res).toEqual({ timedOut: true });
  });
});
