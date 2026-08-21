import type {
  CommentResult, CommitResult, CommitSpec, PrResult, PrSpec, ForgeProvisionResult,
  RepoInfo, RepoRef,
} from "@agent-identity/shared";

/** The acting identity: name is the agentId, email its mailbox address.
 *  Constructed by the core from the authenticated agent record only. */
export interface Author {
  name: string;
  email: string;
}

export type ForgeErrorKind =
  | "not_found" | "non_fast_forward" | "rate_limited" | "upstream_auth"
  | "invalid" | "not_provisioned";

const STATUS: Record<ForgeErrorKind, number> = {
  not_found: 404,
  non_fast_forward: 409,
  rate_limited: 429,
  upstream_auth: 502,
  invalid: 400,
  not_provisioned: 403,
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
  openPullRequest(ref: RepoRef, spec: PrSpec, actor: Author): Promise<PrResult>;
  comment(ref: RepoRef, issue: number, body: string, actor: Author): Promise<CommentResult>;
}

export interface CredentialStore {
  /** Per-identity parameter first, shared fallback; throws
   *  ForgeError("not_provisioned") when neither exists. */
  resolve(service: string, agentId: string): Promise<string>;
}

export interface Provisioner {
  provision(actor: Author): Promise<ForgeProvisionResult>;
}
