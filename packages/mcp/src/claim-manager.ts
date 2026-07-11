import {
  AgentIdentityClient, claimFromPool, hasCapabilities, poolStatus,
  savePoolProfile, type Claim, type PoolProfile, type PoolStatus,
} from "@agent-identity/client";
import { generateKeypair, type AgentIdentity, type Keypair } from "@agent-identity/shared";

export class NoIdentityError extends Error {}

export interface AgentClientLike {
  register(): Promise<AgentIdentity>;
  listEmails(opts: { since?: string; limit?: number }): Promise<{ emails: import("@agent-identity/shared").EmailSummary[] }>;
  getEmail(id: string): Promise<import("@agent-identity/shared").EmailFull>;
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

const capsOf = (p: PoolProfile): string[] => (p.github ? ["github"] : []);

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
    if (require.length > 0) {
      throw new NoIdentityError(
        `no free identity with capabilities [${require.join(",")}]. ` +
        `Onboard a new one (see README: GitHub onboarding) or free one up ` +
        `(inspect ~/.config/agent-identity/claims/).`,
      );
    }
    // Plain exhaustion: mint a new identity.
    if (!this.opts.fleetKey) {
      throw new NoIdentityError(
        "pool is empty and AGENT_IDENTITY_FLEET_KEY is not set, so a new identity cannot be registered",
      );
    }
    const keypair = generateKeypair();
    const client = this.makeClientFn(keypair);
    const identity = await client.register();
    const profile: PoolProfile & { agentId: string } = { ...keypair, ...identity };
    savePoolProfile(profile, this.opts.base);
    const created = await claimFromPool({ base: this.opts.base, exclude });
    if (!created) throw new NoIdentityError("could not claim freshly created identity");
    this.setHeld(created);
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
    savePoolProfile(
      { ...this.held!.claim.profile, ...identity }, this.opts.base,
    );
    this.held!.claim.profile.agentId = identity.agentId;
    this.held!.claim.profile.address = identity.address;
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
