import type { AgentRecord } from "@agent-identity/api";
import { describe, expect, it } from "vitest";
import { evaluate, forkNamespacePolicy } from "./policy.js";

const agent: AgentRecord = {
  agentId: "482913", address: "482913@d", publicKey: "pk",
  status: "active", createdAt: "t", capabilities: ["github"],
};

describe("policy", () => {
  it("allows everything in the MVP", () => {
    expect(evaluate(agent, {
      service: "github", kind: "commit", owner: "critical-labs", repo: "agent-identity",
    })).toEqual({ allow: true });
  });
});

describe("forkNamespacePolicy", () => {
  const gh = { ...agent, capabilities: ["github"] };
  const gl = { ...agent, capabilities: ["gitlab"] };

  it("denies a github commit outside the configured fork owner", () => {
    const p = forkNamespacePolicy({ githubForkOwner: "critical-agent-zero" });
    expect(p(gh, { service: "github", kind: "commit", owner: "critical-labs", repo: "agent-identity" }))
      .toEqual({ allow: false, reason: expect.stringContaining("critical-agent-zero") });
  });

  it("allows a github commit into the fork owner", () => {
    const p = forkNamespacePolicy({ githubForkOwner: "critical-agent-zero" });
    expect(p(gh, { service: "github", kind: "commit", owner: "critical-agent-zero", repo: "agent-identity" }))
      .toEqual({ allow: true });
  });

  it("pins gitlab commits to agent-<id> without extra config", () => {
    const p = forkNamespacePolicy();
    expect(p(gl, { service: "gitlab", kind: "commit", owner: "someone-else", repo: "r" }).allow).toBe(false);
    expect(p(gl, { service: "gitlab", kind: "commit", owner: "agent-482913", repo: "r" }))
      .toEqual({ allow: true });
  });

  it("matches the github fork owner case-insensitively", () => {
    const p = forkNamespacePolicy({ githubForkOwner: "Critical-Agent-Zero" });
    expect(p(gh, { service: "github", kind: "commit", owner: "critical-agent-zero", repo: "r" }))
      .toEqual({ allow: true });
  });

  it("fails CLOSED on a github commit when no fork owner is configured", () => {
    const p = forkNamespacePolicy();
    const d = p(gh, { service: "github", kind: "commit", owner: "anyone", repo: "r" });
    expect(d.allow).toBe(false);
    expect((d as { reason: string }).reason).toMatch(/githubForkOwner/);
  });

  // The fail-closed reason names the refused op, and that text is what the
  // audit line carries; pin the prefix for every pinned kind so a wording
  // slip in one cannot pass unnoticed behind the others' substring matches.
  it("names the refused kind in every fail-closed reason", () => {
    const p = forkNamespacePolicy();
    for (const kind of ["commit", "blob", "sync"] as const) {
      const d = p(gh, { service: "github", kind, owner: "anyone", repo: "r" });
      expect(d.allow, kind).toBe(false);
      expect((d as { reason: string }).reason.startsWith(`GitHub ${kind} blocked`), kind).toBe(true);
    }
  });

  it("does not restrict non-commit ops even when github is unconfigured", () => {
    const p = forkNamespacePolicy();
    expect(p(gh, { service: "github", kind: "fork", owner: "critical-labs", repo: "r" })).toEqual({ allow: true });
    expect(p(gh, { service: "github", kind: "pr", owner: "critical-labs", repo: "r" })).toEqual({ allow: true });
    expect(p(gh, { service: "github", kind: "comment", owner: "critical-labs", repo: "r" })).toEqual({ allow: true });
  });

  // #118: a blob upload is the FIRST write of the streaming commit path, so it
  // must be fork-namespace-pinned exactly like the commit — a blob into the
  // source repo is refused before any object is created.
  it("pins github blob uploads to the fork owner, like commits", () => {
    const p = forkNamespacePolicy({ githubForkOwner: "critical-agent-zero" });
    expect(p(gh, { service: "github", kind: "blob", owner: "critical-labs", repo: "agent-identity" }))
      .toEqual({ allow: false, reason: expect.stringContaining("critical-agent-zero") });
    expect(p(gh, { service: "github", kind: "blob", owner: "critical-agent-zero", repo: "agent-identity" }))
      .toEqual({ allow: true });
  });

  it("fails CLOSED on a github blob when no fork owner is configured", () => {
    const p = forkNamespacePolicy();
    expect(p(gh, { service: "github", kind: "blob", owner: "anyone", repo: "r" }).allow).toBe(false);
  });

  it("pins gitlab blob uploads to agent-<id>", () => {
    const p = forkNamespacePolicy();
    expect(p(gl, { service: "gitlab", kind: "blob", owner: "someone-else", repo: "r" }).allow).toBe(false);
    expect(p(gl, { service: "gitlab", kind: "blob", owner: "agent-482913", repo: "r" }))
      .toEqual({ allow: true });
  });

  // A sync moves a branch ref on the repo the agent names as its fork; aimed
  // at the source it would be a ref write to a repo the agent must never
  // touch, so it is pinned exactly like a commit.
  it("pins a github sync to the fork owner, like commits", () => {
    const p = forkNamespacePolicy({ githubForkOwner: "critical-agent-zero" });
    expect(p(gh, { service: "github", kind: "sync", owner: "critical-labs", repo: "agent-identity" }))
      .toEqual({ allow: false, reason: expect.stringContaining("critical-agent-zero") });
    expect(p(gh, { service: "github", kind: "sync", owner: "critical-agent-zero", repo: "agent-identity" }))
      .toEqual({ allow: true });
    expect(p(gh, { service: "github", kind: "sync", owner: "Critical-Agent-Zero", repo: "agent-identity" }))
      .toEqual({ allow: true });
  });

  it("fails CLOSED on a github sync when no fork owner is configured", () => {
    const p = forkNamespacePolicy();
    const d = p(gh, { service: "github", kind: "sync", owner: "anyone", repo: "r" });
    expect(d.allow).toBe(false);
    expect((d as { reason: string }).reason).toMatch(/sync.*githubForkOwner/);
  });

  it("allows a gitlab sync only in the identity's own namespace", () => {
    const p = forkNamespacePolicy();
    expect(p(gl, { service: "gitlab", kind: "sync", owner: "agent-482913", repo: "r" }))
      .toEqual({ allow: true });
    expect(p(gl, { service: "gitlab", kind: "sync", owner: "someone-else", repo: "r" }))
      .toEqual({ allow: false, reason: expect.stringContaining("agent-482913") });
  });
});
