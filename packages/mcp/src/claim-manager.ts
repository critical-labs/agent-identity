import {
  AgentIdentityClient, claimFromPool, claimSpecific, hasCapabilities, listPool,
  poolStatus, savePoolProfile,
  type Claim, type MeResponse, type PoolProfile, type PoolStatus,
} from "@agent-identity/client";
import {
  generateKeypair, type ActivityEvent, type AgentIdentity, type AgentStatusState,
  type BlobResult, type CommentResult, type CommitChangesSpec, type CommitResult,
  type CommitSpec, type EmailFull, type EmailSummary, type ForgeProvisionResult,
  type ForkResult, type Keypair, type PrResult, type PrSpec,
  type RegisterResponse, type RepoInfo, type RepoRef, type SyncResult,
} from "@agent-identity/shared";

export class NoIdentityError extends Error {}

export interface AgentClientLike {
  register(opts?: { requestedCapabilities?: string[] }): Promise<RegisterResponse>;
  me(): Promise<MeResponse>;
  setStatus(state: AgentStatusState, label?: string): Promise<{ event: ActivityEvent }>;
  reportTaskNote(note: string): Promise<{ event: ActivityEvent }>;
  listEmails(opts: { since?: string; limit?: number; includeUnauthenticated?: boolean }):
    Promise<{ emails: EmailSummary[] }>;
  getEmail(id: string): Promise<EmailFull>;
  forgeRepo(service: string, ref: RepoRef): Promise<RepoInfo>;
  forgeCommit(service: string, ref: RepoRef, spec: CommitSpec): Promise<CommitResult>;
  forgePutBlob(service: string, ref: RepoRef, contentBase64: string): Promise<BlobResult>;
  forgeCommitChanges(service: string, ref: RepoRef, spec: CommitChangesSpec): Promise<CommitResult>;
  forgeOpenPr(service: string, ref: RepoRef, spec: PrSpec): Promise<PrResult>;
  forgeComment(service: string, ref: RepoRef, issue: number, body: string): Promise<CommentResult>;
  forgeFork(service: string, ref: RepoRef): Promise<ForkResult>;
  forgeSync(service: string, ref: RepoRef, branch?: string): Promise<SyncResult>;
  forgeProvision(service: string): Promise<ForgeProvisionResult>;
}

export interface ClaimManagerOptions {
  base?: string;               // pool base dir (default ~/.config/agent-identity)
  apiUrl?: string;
  fleetKey?: string;
  require?: string[];          // from AGENT_IDENTITY_REQUIRE
  makeClient?: (keypair: Keypair) => AgentClientLike;
}

export interface IdentityStatus {
  held: { name: string; agentId?: string; address?: string; capabilities: string[] } | null;
  initError?: string;
  pool: PoolStatus;
}

const capsOf = (p: PoolProfile): string[] =>
  [...new Set([...(p.capabilities ?? []), ...(p.github ? ["github"] : [])])].sort();

export class ClaimManager {
  private held?: { claim: Claim; client: AgentClientLike };
  private initError?: string;
  private readonly makeClientFn: (keypair: Keypair) => AgentClientLike;

  constructor(private readonly opts: ClaimManagerOptions) {
    this.makeClientFn = opts.makeClient
      ?? ((keypair) => new AgentIdentityClient({
        apiUrl: opts.apiUrl!, keypair, fleetKey: opts.fleetKey,
      }));
  }

  async init(): Promise<void> {
    try {
      await this.claim(this.opts.require ?? []);
    } catch (err) {
      // Startup must not crash the MCP server; surface through tools.
      this.initError = (err as Error).message;
    }
  }

  private async claim(require: string[], exclude: string[] = []): Promise<void> {
    const claim = await claimFromPool({ base: this.opts.base, require, exclude });
    if (claim) {
      this.setHeld(claim);
      return;
    }
    const starvation = `no free identity with capabilities [${require.join(",")}]. ` +
      `Onboard a new one (see README: GitHub onboarding) or free one up ` +
      `(inspect ~/.config/agent-identity/claims/).`;
    if (!this.opts.fleetKey) {
      throw new NoIdentityError(require.length > 0
        ? starvation
        : "pool is empty and AGENT_IDENTITY_FLEET_KEY is not set, so a new identity cannot be registered");
    }
    // Exhaustion — or a require no pool identity satisfies: mint a new
    // identity through the same fleet-key path as plain auto-provision. With
    // a require set, ask the deployment's AUTO_CAPABILITIES policy for birth
    // grants; whether anything is granted is decided server-side by the
    // operator's policy, never by this client.
    //
    // Every registration is a PERMANENT server-side identity (agent record,
    // mailbox address from the finite agentId space, roster entry), so a
    // require the policy refuses must not mint one per retry or restart: a
    // free pool profile already carrying a refusal for any of these
    // capabilities is proof the probe was made and refused — fail on that
    // evidence instead of registering another.
    if (require.length > 0) {
      const parked = await this.freeRefusedProbe(require, exclude);
      if (parked) {
        throw new NoIdentityError(
          `${starvation} A registration already probed the deployment policy for ` +
          `[${require.join(",")}] and was refused (parked as pool profile ${parked}), ` +
          `so another identity is not registered. If the operator has since enabled ` +
          `AUTO_CAPABILITIES for these capabilities, claim or remove that parked ` +
          `profile to allow a fresh registration.`,
        );
      }
    }
    const keypair = generateKeypair();
    const client = this.makeClientFn(keypair);
    const identity = await client.register(
      require.length > 0 ? { requestedCapabilities: require } : {});
    const granted = identity.capabilities ?? [];
    const refused = require.filter((cap) => !granted.includes(cap));
    // Save before checking the grant: even a refused-grant identity is a
    // valid plain one — keeping it avoids orphaning a registered keypair.
    // A refusal is recorded on the profile (grants are birth-only, so it is
    // permanent for this identity) to suppress repeat probe registrations.
    const profile: PoolProfile & { agentId: string } = {
      ...keypair, ...identity,
      ...(refused.length > 0 ? { refusedCapabilities: refused } : {}),
    };
    savePoolProfile(profile, this.opts.base);
    if (refused.length > 0) {
      // Policy off (or not covering the require): the starvation remediation
      // stands, with the deployment-policy option added for the operator.
      throw new NoIdentityError(
        `${starvation} Alternatively, the operator can enable the auto-capabilities ` +
        `deployment policy (AUTO_CAPABILITIES listing ${require.join(",")}) so ` +
        `registration mints capable identities on demand.`,
      );
    }
    const created = await claimFromPool({ base: this.opts.base, require, exclude });
    if (!created) throw new NoIdentityError("could not claim freshly created identity");
    this.setHeld(created);
  }

  // A FREE pool profile whose recorded policy refusal overlaps the require:
  // standing proof that minting again would be refused too. Only free
  // profiles count — a parked probe consumed by a plain session (it is a
  // valid plain identity) stops suppressing, so pool growth is bounded by
  // real identity consumption, exactly like plain auto-provision.
  private async freeRefusedProbe(
    require: string[], exclude: string[],
  ): Promise<string | undefined> {
    for (const { name, profile } of listPool(this.opts.base)) {
      if (exclude.includes(name)) continue;
      const refused = profile.refusedCapabilities ?? [];
      if (!require.some((cap) => refused.includes(cap))) continue;
      const probe = await claimSpecific(name, { base: this.opts.base });
      if (probe) {
        probe.release(); // freeness check only — never held
        return name;
      }
    }
    return undefined;
  }

  private setHeld(claim: Claim): void {
    this.held = { claim, client: this.makeClientFn(claim.profile) };
    this.initError = undefined;
  }

  client(): AgentClientLike {
    if (!this.held) {
      throw new NoIdentityError(this.initError ?? "no identity claimed for this session");
    }
    return this.held.client;
  }

  async ensureIdentity(require?: string[]): Promise<AgentIdentity> {
    const effective = require ?? this.opts.require ?? [];
    if (this.held && !hasCapabilities(this.held.claim.profile, effective)) {
      // Claim the qualifying profile FIRST; only then release the old one,
      // so a failed swap never leaves the session identity-less.
      const previous = this.held;
      await this.claim(effective, [previous.claim.name]);
      previous.claim.release();
    } else if (!this.held) {
      await this.claim(effective);
    }
    const identity = await this.held!.client.register();
    this.held!.claim.profile.agentId = identity.agentId;
    this.held!.claim.profile.address = identity.address;
    // Record server-known capabilities when the response carries them (an
    // older server omits the field — keep what the profile already has).
    if (identity.capabilities) this.held!.claim.profile.capabilities = identity.capabilities;
    savePoolProfile(
      { ...this.held!.claim.profile, agentId: identity.agentId }, this.opts.base,
    );
    return identity;
  }

  status(): IdentityStatus {
    return {
      held: this.held
        ? {
            name: this.held.claim.name,
            agentId: this.held.claim.profile.agentId,
            address: this.held.claim.profile.address,
            capabilities: capsOf(this.held.claim.profile),
          }
        : null,
      ...(this.initError ? { initError: this.initError } : {}),
      pool: poolStatus({ base: this.opts.base }),
    };
  }

  release(): void {
    this.held?.claim.release();
    this.held = undefined;
  }
}
