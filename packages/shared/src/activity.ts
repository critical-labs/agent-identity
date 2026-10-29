// Fleet activity ledger types shared by the API, proxy, ingest, and MCP
// packages. Design principle (docs/): agents stay separate and autonomous —
// ATTESTED events are written only by infrastructure that observed the act;
// CLAIMED events are signed agent self-reports. No path may ever store or
// return a claimed event as attested.
import { sanitizeMailText } from "./mail.js";

export const ATTESTED_ACTIVITY_TYPES = [
  "forge_commit", "forge_fork", "forge_sync", "forge_pr", "forge_comment",
  "email_received", "email_rejected", "capability_granted",
] as const;

export const CLAIMED_ACTIVITY_TYPES = ["status", "task_note"] as const;

export type AttestedActivityType = (typeof ATTESTED_ACTIVITY_TYPES)[number];
export type ClaimedActivityType = (typeof CLAIMED_ACTIVITY_TYPES)[number];
export type ActivityClass = "attested" | "claimed";

export const STATUS_STATES = ["working", "idle", "blocked"] as const;
export type AgentStatusState = (typeof STATUS_STATES)[number];

// Hard caps on agent-supplied strings, enforced at WRITE time.
export const STATUS_LABEL_MAX = 120;
export const TASK_NOTE_MAX = 500;

export interface ActivityEvent {
  agentId: string;
  ts: string;                       // ISO timestamp
  class: ActivityClass;
  type: AttestedActivityType | ClaimedActivityType;
  summary: string;
  // Structured, type-specific fields, e.g. { repo, sha, branch } for
  // forge_commit or { senderDomain } for email_received (never subject/body).
  detail?: Record<string, string | number | boolean>;
  ref?: string;                     // canonical URL of the act, when one exists
}

/** The overwritten per-agent STATUS row. */
export interface AgentStatus {
  state: AgentStatusState;
  label?: string;
  updatedAt: string;                // ISO
}

/** What readers get: staleness is computed server-side at read time. */
export interface AgentStatusView extends AgentStatus {
  stale: boolean;
}

// Activity text fields (status labels, task notes, attested summaries and
// detail values) are single-line by nature — unlike mail bodies, they have
// no legitimate multi-line use. sanitizeMailText deliberately keeps \n and
// \t for mail; here a kept newline would let stored text fabricate an extra
// feed row in any line-oriented rendering (terminal dashboards, logs), so
// runs of \n/\t collapse to a single space. (\r is already stripped by
// sanitizeMailText's control-character class.)
const LINE_BREAKS_RE = /[\n\t]+/g;

// Same storage-layer character defense as stored mail (ANSI/C1, zero-width,
// bidi overrides), collapsed to a single line, then the hard length cap.
// Sanitize FIRST so stripped characters cannot smuggle length past the cap.
export function sanitizeActivityText(text: string, max: number): string {
  return sanitizeMailText(text).replace(LINE_BREAKS_RE, " ").slice(0, max);
}

// Attested events embed strings that agents (branch and repo names) or
// outside senders (mail domains) ultimately control; forges allow arbitrary
// non-ASCII and unbounded length in refnames. Every attested writer (the
// proxy's central run() write, ingest) must pass its event through this
// helper so no individual route can forget the defense: the same character
// stripping as claimed text plus a hard length cap, applied to the summary,
// every string detail value, and the ref.
export const ATTESTED_TEXT_MAX = 500;

export function sanitizeAttestedEvent(event: ActivityEvent): ActivityEvent {
  const clean = (v: string) => sanitizeActivityText(v, ATTESTED_TEXT_MAX);
  return {
    ...event,
    summary: clean(event.summary),
    ...(event.detail !== undefined
      ? {
          detail: Object.fromEntries(Object.entries(event.detail).map(
            ([key, value]) => [key, typeof value === "string" ? clean(value) : value],
          )),
        }
      : {}),
    ...(event.ref !== undefined ? { ref: clean(event.ref) } : {}),
  };
}
