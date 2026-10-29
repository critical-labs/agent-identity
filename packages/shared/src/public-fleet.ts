// Public fleet tier projection. Operator's requirement, verbatim: "I want a
// public view of agents, but only when they are working on public repos;
// private repos like homefree should never be mentioned publicly."
//
// Fail-closed is the law of this module: an event reaches the public tier
// only by matching an explicit rule below, and every projected event is
// REBUILT field by field — nothing is passed through wholesale, so a stray
// stored attribute can never ride along. When in doubt, show nothing.
import { STATUS_STATES, type ActivityEvent, type AgentStatusState } from "./activity.js";

// ---- repo allowlist -------------------------------------------------------

// One owner or repo segment, after lowercasing: the forge-name charset the
// proxy already enforces, minus all-dot names. Anything else (whitespace,
// unicode, empty) invalidates the pattern or candidate.
const SEGMENT_RE = /^[a-z0-9_.-]+$/;
const ALL_DOTS_RE = /^\.+$/;

const isSegment = (s: string): boolean => SEGMENT_RE.test(s) && !ALL_DOTS_RE.test(s);

/** Split a lowercase "owner/repo" into exactly two valid segments, else undefined. */
function splitRepo(candidate: string): [string, string] | undefined {
  const parts = candidate.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (!isSegment(owner) || !isSegment(repo)) return undefined;
  return [owner, repo];
}

// A valid pattern is "owner/repo" or "owner/*": literal owner segment,
// literal repo segment or the exact wildcard "*". Partial wildcards
// ("owner/re*") and wildcard owners ("*/repo") are NOT patterns — a
// malformed pattern must narrow the allowlist, never widen it.
function parsePattern(pattern: string): { owner: string; repo: string } | undefined {
  const parts = pattern.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (!isSegment(owner)) return undefined;
  if (repo !== "*" && !isSegment(repo)) return undefined;
  return { owner, repo };
}

/** Parse the comma-separated PUBLIC_REPOS value ("owner/repo" / "owner/*")
 *  into normalized (lowercased, trimmed) patterns. Malformed entries are
 *  dropped; the empty string parses to the empty allowlist, which matches
 *  nothing — the fail-closed default. */
export function parseRepoAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0 && parsePattern(p) !== undefined);
}

/** Case-insensitive, exact-segment match of one "owner/repo" candidate
 *  against the allowlist. Patterns are re-validated here, so handing this
 *  function raw, unparsed strings can only narrow the result, never widen
 *  it. "critical-labs/*" matches neither "critical-labs-evil/x" nor
 *  "evil/critical-labs" nor "critical-labs/x/y". */
export function repoMatchesAllowlist(candidate: unknown, allowlist: readonly string[]): boolean {
  if (typeof candidate !== "string") return false;
  const split = splitRepo(candidate.toLowerCase());
  if (!split) return false;
  const [owner, repo] = split;
  return allowlist.some((raw) => {
    const p = parsePattern(raw.trim().toLowerCase());
    return p !== undefined && p.owner === owner && (p.repo === "*" || p.repo === repo);
  });
}

// ---- forge ref re-validation ----------------------------------------------

const FORGE_ORIGINS = new Set(["https://github.com", "https://gitlab.com"]);

/** A ref survives only when it parses as a URL with EXACTLY a forge origin
 *  (https, canonical host, default port) AND its path sits at or under the
 *  event's own allowlisted repo at a segment boundary. Everything else —
 *  lookalike hosts, other repos on the real host, path suffix tricks,
 *  non-URLs — drops the ref while keeping the event. */
function publicRef(ref: string | undefined, repo: string): string | undefined {
  if (typeof ref !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return undefined;
  }
  if (!FORGE_ORIGINS.has(url.origin)) return undefined;
  const path = url.pathname.toLowerCase();
  const prefix = `/${repo.toLowerCase()}`;
  return path === prefix || path.startsWith(`${prefix}/`) ? ref : undefined;
}

// ---- event projection ------------------------------------------------------

// Per forge type: which detail fields carry repo names (ALL present ones
// must be allowlisted or the event is dropped) and which detail fields may
// be copied into the public projection at all.
const FORGE_RULES: Record<string, { repoFields: string[]; detailFields: string[] }> = {
  forge_commit: { repoFields: ["repo"], detailFields: ["service", "repo", "branch", "sha"] },
  forge_pr: { repoFields: ["repo"], detailFields: ["service", "repo", "number"] },
  forge_comment: { repoFields: ["repo"], detailFields: ["service", "repo", "issue"] },
  forge_fork: { repoFields: ["source", "fork"], detailFields: ["service", "source", "fork"] },
  // A sync names only the fork: the upstream it synced from is the forge's
  // choice, not a field the agent supplied, and the event carries no ref.
  forge_sync: { repoFields: ["fork"], detailFields: ["service", "fork", "branch", "mergeType"] },
};

const FORGE_SENDER_DOMAINS = ["github.com", "gitlab.com"];

/** Label-boundary domain match: the domain itself or a real subdomain. */
function isForgeSenderDomain(domain: unknown): domain is string {
  if (typeof domain !== "string") return false;
  const d = domain.toLowerCase();
  return FORGE_SENDER_DOMAINS.some(
    (base) => d === base || (d.endsWith(`.${base}`) && d.length > base.length + 1),
  );
}

/** Project ONE event for the public tier: the projected event, or undefined
 *  when the event must not appear publicly. Exported so storage reads can be
 *  projection-aware: a reader that fetches a fixed RAW window and projects
 *  afterwards lets excluded (private) events displace public ones from the
 *  window — turning feed deltas into a public read-out of private volume,
 *  and vanishing legitimately publishable events. Callers page/filter with
 *  this predicate until `limit` PUBLIC events are collected or the log is
 *  exhausted (see the API's /fleet/public routes). */
export function projectPublicEvent(
  e: ActivityEvent, allowlist: readonly string[],
): ActivityEvent | undefined {
  const rule = FORGE_RULES[e.type];
  if (rule) {
    // Forge events must be attested (the write path guarantees it; a
    // laundered claimed row is dropped here anyway) and every repo-shaped
    // field must exist AND match the allowlist.
    if (e.class !== "attested" || e.detail === undefined) return undefined;
    const detail = e.detail;
    // The name allowlist is necessary but NOT sufficient: an "owner/*"
    // pattern also covers every PRIVATE repo that owner has or later gains.
    // The proxy therefore stamps detail.visibility with the repo's ACTUAL
    // visibility, read from the forge at attestation time, and only the
    // exact string "public" opens the public tier. A missing stamp (events
    // attested before stamping existed, or a writer that forgot), "private",
    // or any other value keeps the event out — fail closed. The stamp is a
    // gate, not payload: it is not in any detailFields list, so it never
    // appears in the public output.
    if (detail.visibility !== "public") return undefined;
    const repos = rule.repoFields.map((f) => detail[f]);
    if (!repos.every((r) => repoMatchesAllowlist(r, allowlist))) return undefined;
    const publicDetail = Object.fromEntries(
      rule.detailFields.flatMap((f) => (detail[f] !== undefined ? [[f, detail[f]]] : [])),
    );
    // The ref is re-validated against the event's OWN repo; forge_fork
    // events never carry a ref in the public tier.
    const repo = typeof detail.repo === "string" ? detail.repo : undefined;
    const ref = repo !== undefined ? publicRef(e.ref, repo) : undefined;
    return {
      agentId: e.agentId, ts: e.ts, class: "attested", type: e.type,
      summary: e.summary, detail: publicDetail,
      ...(ref !== undefined ? { ref } : {}),
    };
  }

  if (e.type === "status") {
    // Claimed status passes with state + ts ONLY: the label is stripped from
    // detail AND the summary is rebuilt so stored label text cannot leak.
    if (e.class !== "claimed") return undefined;
    const state = e.detail?.state;
    if (!STATUS_STATES.includes(state as AgentStatusState)) return undefined;
    return {
      agentId: e.agentId, ts: e.ts, class: "claimed", type: "status",
      summary: `status: ${state}`, detail: { state: state as AgentStatusState },
    };
  }

  if (e.type === "email_received") {
    const domain = e.detail?.senderDomain;
    if (e.class !== "attested" || !isForgeSenderDomain(domain)) return undefined;
    return {
      agentId: e.agentId, ts: e.ts, class: "attested", type: "email_received",
      summary: `email received from ${domain}`, detail: { senderDomain: domain },
    };
  }

  // task_note, capability_granted, and anything unknown: never public.
  return undefined;
}

// ---- public projections ----------------------------------------------------

export interface PublicAgentStatus {
  state: AgentStatusState;
  stale: boolean;
}

export interface PublicFleetAgent {
  agentId: string;
  capabilities: string[];
  status?: PublicAgentStatus;
  /** Recomputed over PUBLIC events only — a fleet with 100 private events
   *  and 0 public ones shows counts of 0. */
  counts: { attested: number; claimed: number };
}

/** Structural input: the API's FleetAgent satisfies this. Extra fields
 *  (stored counts, status label/updatedAt) are ignored, never copied. */
export interface PublicRosterInput {
  agentId: string;
  capabilities?: string[];
  status?: { state: AgentStatusState; stale: boolean };
}

export interface PublicFleetView {
  agents: PublicFleetAgent[];
  events: ActivityEvent[];
}

/** Pure projection for the unauthenticated fleet tier. Excluded events are
 *  ABSENT — no placeholder, no count. NOTE: absence alone does not remove
 *  the tempo side channel; that also requires the caller's storage read to
 *  be projection-aware (projectPublicEvent above), so that excluded events
 *  can never displace public ones from a fixed pre-projection window. */
export function publicView(
  events: readonly ActivityEvent[],
  roster: readonly PublicRosterInput[],
  allowlist: readonly string[],
): PublicFleetView {
  const publicEvents: ActivityEvent[] = [];
  for (const e of events) {
    const projected = projectPublicEvent(e, allowlist);
    if (projected) publicEvents.push(projected);
  }

  const agents = roster.map((a): PublicFleetAgent => {
    const counts = { attested: 0, claimed: 0 };
    for (const e of publicEvents) {
      if (e.agentId === a.agentId) counts[e.class] += 1;
    }
    const state = a.status?.state;
    return {
      agentId: a.agentId,
      capabilities: [...(a.capabilities ?? [])],
      ...(STATUS_STATES.includes(state as AgentStatusState)
        ? { status: { state: state as AgentStatusState, stale: a.status?.stale === true } }
        : {}),
      counts,
    };
  });

  return { agents, events: publicEvents };
}
