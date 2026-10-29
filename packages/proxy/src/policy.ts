import type { AgentRecord } from "@agent-identity/api";
import { gitlabServiceAccountUsername } from "./gitlab-names.js";

/** The parsed, typed operation — exactly what issue #23's deterministic
 *  rules will pattern-match on. */
export interface ForgeOp {
  service: string;
  kind: "repo" | "commit" | "blob" | "pr" | "comment" | "provision" | "fork" | "sync";
  owner: string;
  repo: string;
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

// Allow-all in the #22 MVP; #23 replaces the body, not the signature.
export function evaluate(_agent: AgentRecord, _op: ForgeOp): PolicyDecision {
  return { allow: true };
}

export type Policy = (agent: AgentRecord, op: ForgeOp) => PolicyDecision;

export interface ForkPolicyConfig {
  /** The shared GitHub PAT account login (the GitHub fork namespace). When
   *  unset, GitHub commits are DENIED (fail closed) rather than allowed — the
   *  operator must pass -c githubForkOwner=<bot-login> to enable GitHub commits. */
  githubForkOwner?: string;
}

const deny = (expected: string, owner: string): PolicyDecision => ({
  allow: false,
  reason: `writes must target the fork namespace "${expected}", not "${owner}"`,
});

/** Deterministic guard-rail (issue #23): a write may only target the calling
 *  identity's fork namespace, never the source repo. GitLab forks live in the
 *  identity's own service-account namespace (agent-<id>), derivable with no
 *  config; GitHub uses one shared fork account, supplied via config. */
export function forkNamespacePolicy(config: ForkPolicyConfig = {}): Policy {
  return (agent, op) => {
    // The pinned kinds are every write to a repo the agent names as its
    // fork. Blob uploads are the first write in the streaming commit path
    // (#118): they must be pinned exactly like the commit, or a rejected
    // target could still leave dangling objects in the source repo. A sync
    // moves a branch ref on the named repo from its upstream: aimed at the
    // source it would be a ref write to a repo the agent must never touch,
    // so it is pinned too — and fails closed on GitHub without a configured
    // fork owner, as commits do.
    if (op.kind !== "commit" && op.kind !== "blob" && op.kind !== "sync") return { allow: true };
    if (op.service === "gitlab") {
      const expected = gitlabServiceAccountUsername(agent.agentId);
      return op.owner === expected ? { allow: true } : deny(expected, op.owner);
    }
    if (op.service === "github") {
      // Fail closed: without a configured fork owner we cannot tell a fork
      // target from the source, so refuse the write rather than allow it.
      if (!config.githubForkOwner) {
        return {
          allow: false,
          reason: `GitHub ${op.kind} blocked: the proxy is not configured with a fork owner `
            + "(deploy with -c githubForkOwner=<bot-login>)",
        };
      }
      // GitHub logins are case-insensitive; compare accordingly.
      return op.owner.toLowerCase() === config.githubForkOwner.toLowerCase()
        ? { allow: true }
        : deny(config.githubForkOwner, op.owner);
    }
    // Unknown service: it has no registered forge (guard already 404s those),
    // and no fork-namespace concept to enforce.
    return { allow: true };
  };
}
