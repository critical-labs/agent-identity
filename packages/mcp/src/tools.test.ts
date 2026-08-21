import { describe, expect, it, vi } from "vitest";
import type { ClaimManager } from "./claim-manager.js";
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

describe("forge tools", () => {
  function managerWith(client: Record<string, unknown>): ClaimManager {
    return { client: () => client } as never;
  }

  it("forge_commit delegates to the client with service defaulting to github", async () => {
    const forgeCommit = vi.fn(async () => ({ sha: "c1", url: "u" }));
    const tools = makeTools(managerWith({ forgeCommit }));
    const result = await tools.forgeCommit({
      owner: "o", repo: "r", branch: "b", message: "m",
      files: [{ path: "f", content: "x" }],
    });
    expect(result).toEqual({ sha: "c1", url: "u" });
    expect(forgeCommit).toHaveBeenCalledWith("github", { owner: "o", name: "r" },
      { branch: "b", message: "m", files: [{ path: "f", content: "x" }] });
  });

  it("forge tools return proxy errors as clean results", async () => {
    const forgeCommit = vi.fn(async () => {
      throw new Error('API 403: {"error":"missing_capability","remediation":"ask the operator"}');
    });
    const tools = makeTools(managerWith({ forgeCommit }));
    const result = await tools.forgeCommit({
      owner: "o", repo: "r", branch: "b", message: "m",
      files: [{ path: "f", content: "x" }],
    });
    expect(result).toEqual({
      error: 'API 403: {"error":"missing_capability","remediation":"ask the operator"}',
    });
  });

  it("forge_open_pr and forge_comment delegate with explicit service", async () => {
    const forgeOpenPr = vi.fn(async () => ({ number: 2, url: "u" }));
    const forgeComment = vi.fn(async () => ({ id: 4, url: "u" }));
    const tools = makeTools(managerWith({ forgeOpenPr, forgeComment }));
    await tools.forgeOpenPr({
      service: "gitlab", owner: "o", repo: "r",
      head: "h", base: "b", title: "t", body: "d",
    });
    await tools.forgeComment({ owner: "o", repo: "r", issue: 4, body: "hi" });
    expect(forgeOpenPr).toHaveBeenCalledWith("gitlab", { owner: "o", name: "r" },
      { head: "h", base: "b", title: "t", body: "d" });
    expect(forgeComment).toHaveBeenCalledWith("github", { owner: "o", name: "r" }, 4, "hi");
  });
});
