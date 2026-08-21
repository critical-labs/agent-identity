import type { AgentRecord } from "@agent-identity/api";
import { describe, expect, it } from "vitest";
import { evaluate } from "./policy.js";

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
