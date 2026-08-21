import type { AgentRecord } from "@agent-identity/api";

/** The parsed, typed operation — exactly what issue #23's deterministic
 *  rules will pattern-match on. */
export interface ForgeOp {
  service: string;
  kind: "repo" | "commit" | "pr" | "comment";
  owner: string;
  repo: string;
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

// Allow-all in the #22 MVP; #23 replaces the body, not the signature.
export function evaluate(_agent: AgentRecord, _op: ForgeOp): PolicyDecision {
  return { allow: true };
}
