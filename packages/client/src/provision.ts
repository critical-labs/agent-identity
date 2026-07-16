import { generateKeypair, type AgentIdentity, type Keypair } from "@agent-identity/shared";
import { savePoolProfile } from "./claims.js";
import { AgentIdentityClient } from "./client.js";

export interface ProvisionClientLike {
  register(): Promise<AgentIdentity>;
}

export interface ProvisionOptions {
  count: number;
  apiUrl: string;
  fleetKey: string;
  base?: string;
  makeClient?: (keypair: Keypair) => ProvisionClientLike;
}

export interface ProvisionResult {
  agentId?: string;
  address?: string;
  error?: string;
}

export async function provisionIdentities(opts: ProvisionOptions): Promise<ProvisionResult[]> {
  const makeClient = opts.makeClient
    ?? ((keypair: Keypair) => new AgentIdentityClient({
      apiUrl: opts.apiUrl, keypair, fleetKey: opts.fleetKey,
    }));
  const results: ProvisionResult[] = [];
  for (let i = 0; i < opts.count; i++) {
    const keypair = generateKeypair();
    try {
      const identity = await makeClient(keypair).register();
      savePoolProfile({ ...keypair, ...identity }, opts.base);
      results.push({ agentId: identity.agentId, address: identity.address });
    } catch (err) {
      results.push({ error: (err as Error).message });
    }
  }
  return results;
}
