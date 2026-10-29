import type {
  BlobResult, BlobSpec, CommentResult, CommitChangesSpec, CommitResult, CommitSpec,
  ForgeProvisionResult, ForkResult, PrResult, PrSpec,
  RepoInfo, RepoRef, RepoVisibility, SyncResult,
} from "@agent-identity/shared";

/** The acting identity: name is the agentId, email its mailbox address.
 *  Constructed by the core from the authenticated agent record only. */
export interface Author {
  name: string;
  email: string;
}

export type ForgeErrorKind =
  | "not_found" | "forbidden" | "non_fast_forward" | "rate_limited"
  | "upstream_auth" | "invalid" | "not_provisioned" | "fork_diverged";

const STATUS: Record<ForgeErrorKind, number> = {
  not_found: 404,
  forbidden: 403,
  non_fast_forward: 409,
  rate_limited: 429,
  upstream_auth: 502,
  invalid: 400,
  not_provisioned: 403,
  // A fork branch that is ahead of its upstream — by any commit, conflicting
  // or not — cannot be synced without a merge the proxy refuses to make for
  // the agent; the agent's remedy is a fresh branch, so this is a conflict,
  // not a bad request.
  fork_diverged: 409,
};

export const statusFor = (kind: ForgeErrorKind): number => STATUS[kind];

export class ForgeError extends Error {
  constructor(
    public readonly kind: ForgeErrorKind,
    message: string,
    public readonly upstream?: number,
  ) {
    super(message);
  }
}

/** The hexagon's outbound port. Every operation executes AS an identity:
 *  actor is supplied by the core from the authenticated record — adapters
 *  must never accept caller-controlled authorship, and per-identity
 *  adapters (gitlab) resolve the actor's own credential from actor.name. */
export interface Forge {
  getRepo(ref: RepoRef, actor: Author): Promise<RepoInfo>;
  createCommit(ref: RepoRef, spec: CommitSpec, actor: Author): Promise<CommitResult>;
  /** Upload one file's bytes as a blob and return its sha (#118). Streaming
   *  path: the caller uploads each file separately so no single request
   *  carries the whole change. Policy-gated identically to a commit — a
   *  rejected target must create NOTHING. GitLab carries content inline in
   *  the commit and rejects this as unsupported. */
  putBlob(ref: RepoRef, spec: BlobSpec, actor: Author): Promise<BlobResult>;
  /** Size-agnostic commit (#118): a tree/actions-based commit over a set of
   *  changes (pre-uploaded blobs, inline content, or deletions). Authorship
   *  is FORCED to the actor exactly as createCommit; branch auto-create and
   *  the fork-namespace pin are unchanged. */
  commitChanges(ref: RepoRef, spec: CommitChangesSpec, actor: Author): Promise<CommitResult>;
  openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult>;
  comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult>;
  fork(ref: RepoRef, actor: Author): Promise<ForkResult>;
  /** Bring one branch of the identity's FORK level with the same branch on
   *  its upstream, using the credential the proxy already holds. Exists
   *  because GitHub never syncs a fork on its own, and a private upstream
   *  cannot even be read by a fork-scoped token the operator might hand an
   *  agent — so without this the operator is the only one who can give a PR
   *  a fresh base. `ref` names the fork, never the source; it is a write to
   *  the fork and is fork-namespace-pinned by the proxy policy exactly like a
   *  commit. A sync only ever fast-forwards: a branch that is merely behind
   *  moves to the upstream head, one already level is a no-op ("none"), and
   *  one that is ahead of upstream by any commit — conflicting or not — is
   *  refused with ForgeError("fork_diverged") BEFORE the forge is asked,
   *  because the forge's own sync would otherwise create a merge commit under
   *  the shared fork account, outside the authored-and-signed commit path.
   *  The agent starts a new branch instead. */
  syncFork(ref: RepoRef, branch: string, actor: Author): Promise<SyncResult>;
  /** The repo's ACTUAL visibility on the forge right now. Adapters answer
   *  "public" ONLY for a world-readable repo; private, internal, and
   *  malformed upstream payloads all collapse to "private". The proxy uses
   *  this to stamp attested forge events — the public fleet tier shows a
   *  forge event only when that stamp is exactly "public", so a name
   *  allowlist (owner/*) can never publish a private repo. */
  repoVisibility(ref: RepoRef, actor: Author): Promise<RepoVisibility>;
}

/** Signs the commit object the proxy constructs so the forge reports the
 *  commit `verified` (issue #120). The committer identity is stamped on the
 *  commit (the signing bot, whose public key is registered as a signing key on
 *  its forge account); the author stays the acting agent. */
export interface CommitSigner {
  committer: Author;
  /** SSH-sign the canonical git commit object, returning the armored
   *  "-----BEGIN SSH SIGNATURE-----" blob for the commit API's signature
   *  field. Synchronous: signing is a pure crypto operation over the bytes. */
  sign(canonicalCommitObject: Buffer): string;
}

export interface CredentialStore {
  /** Per-identity parameter first, shared fallback; throws
   *  ForgeError("not_provisioned") when neither exists. Used for every
   *  non-commit call (fork, PR-open, comment, repo reads). */
  resolve(service: string, agentId: string): Promise<string>;
  /** Token for the COMMIT write path. For github, mints a GitHub App
   *  installation token when the app is configured (a revocable, per-installation
   *  auth for the commit-API calls — issue #121); a fully-absent app config
   *  falls back to resolve() (the PAT), and a partially-configured app FAILS
   *  CLOSED. Other services fall back to resolve(). This is AUTH only —
   *  signing (verified=true) is a separate concern, see resolveCommitSigner. */
  resolveCommitToken(service: string, agentId: string): Promise<string>;
  /** The commit signer when SSH commit signing is configured for the service
   *  (the forge then reports the commit `verified` — issue #120), or undefined
   *  when it is not (unsigned, as before). For github, reads the ed25519
   *  signing key + committer identity from the store; FAILS CLOSED (throws)
   *  when the key is present but the committer identity is not, so a half-set
   *  signer can never silently emit an unverifiable commit. Non-signing
   *  services (gitlab) return undefined. */
  resolveCommitSigner(service: string, agentId: string): Promise<CommitSigner | undefined>;
}

export interface Provisioner {
  provision(actor: Author): Promise<ForgeProvisionResult>;
}
