export interface AgentIdentity {
  agentId: string;        // numeric string, e.g. "482913"
  address: string;        // "482913@mail.example.com"
}

export type AuthVerdictStatus = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";

// SES receipt verdicts captured at ingest. Records stored before capture
// lack the field entirely — every reader must tolerate undefined.
export interface EmailAuthVerdicts {
  spf?: AuthVerdictStatus;
  dkim?: AuthVerdictStatus;
  dmarc?: AuthVerdictStatus;
  spam?: AuthVerdictStatus;
  virus?: AuthVerdictStatus;
}

export interface EmailSummary {
  id: string;             // ULID
  from: string;
  subject: string;
  receivedAt: string;     // ISO
  auth?: EmailAuthVerdicts;
  // Sender domain was not on the ingest allowlist. Records stored before the
  // allowlist (field absent) are grandfathered as solicited.
  unsolicited?: boolean;
}

export interface EmailFull extends EmailSummary {
  text: string;
  html?: string;
  links: string[];
}

export interface RegisterResponse extends AgentIdentity {
  // Capabilities on the record after registration — birth grants applied by
  // the deployment's AUTO_CAPABILITIES policy, or the existing set on an
  // idempotent re-register. Absent on servers predating the field.
  capabilities?: string[];
}

// --- forge proxy DTOs (see docs/forge-access.md; history: docs/internal/specs/) ---

export interface RepoRef {
  owner: string;
  name: string;
}

export interface ForgeFile {
  path: string;
  content: string;
}

export interface CommitSpec {
  branch: string;
  message: string;
  files: ForgeFile[];
}

/** A single change in a size-agnostic (tree/actions-based) commit (#118).
 *  Content never routes through the model as a whole file: the MCP server
 *  reads bytes from disk, so an add/modify is delivered either as a
 *  pre-uploaded blob (GitHub `blobSha`) or as inline `content`.
 *  Field semantics are service-scoped because the commit route is
 *  per-service: GitHub reads `content` as UTF-8 tree content (the small
 *  model-supplied inline case) and streams disk files through `blobSha`;
 *  GitLab always receives `content` base64-encoded (its commits API carries
 *  content inline) and never `blobSha`. */
export type CommitChange =
  | { path: string; blobSha: string }
  | { path: string; content: string }
  | { path: string; deleted: true };

export interface CommitChangesSpec {
  branch: string;
  message: string;
  changes: CommitChange[];
}

/** Payload for the blob-upload port (#118): one file's bytes, base64. */
export interface BlobSpec {
  contentBase64: string;
}

export interface BlobResult {
  sha: string;
}

export interface PrSpec {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** A repo's ACTUAL visibility on the forge, as read at attestation time.
 *  Deliberately binary: anything that is not world-readable ("private",
 *  GitLab "internal", GHES "internal", unknown) collapses to "private" —
 *  the public fleet tier publishes a forge event only when the proxy
 *  stamped detail.visibility === "public". */
export type RepoVisibility = "public" | "private";

export interface RepoInfo {
  defaultBranch: string;
  headSha: string;
}

export interface CommitResult {
  sha: string;
  url: string;
}

export interface PrResult {
  number: number;
  url: string;
}

export interface CommentResult {
  id: number;
  url: string;
}

export interface ForgeProvisionResult {
  username: string;
  email: string;
}

export interface ForkResult {
  owner: string;
  repo: string;
  defaultBranch: string;
}

/** Outcome of syncing a fork branch from its upstream (forge_sync). GitHub
 *  never keeps a fork level with its upstream on its own, so the proxy —
 *  which holds the fork-account credential — does it on request. mergeType
 *  is the forge's own verdict: "fast-forward" (the fork branch moved) or
 *  "none" (already level). "merge" means the forge created a merge commit
 *  under the fork account; the proxy refuses any branch that is ahead of
 *  upstream before asking the forge (fork_diverged), so "merge" is only ever
 *  the trace of a race and is kept in the type so the ledger records it
 *  rather than hides it. baseBranch is the upstream ref the fork was synced
 *  from, as the forge names it (GitHub: "<upstream-owner>:<branch>"). */
export interface SyncResult {
  mergeType: "fast-forward" | "merge" | "none";
  baseBranch: string;
  message: string;
}
