import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ForgeError, type CredentialStore } from "./forge.js";

const TTL_MS = 300_000;

export class SsmCredentialStore implements CredentialStore {
  private readonly cache = new Map<string, { value: string; at: number }>();

  constructor(
    private readonly basePath: string = "/agent-identity/forge",
    private readonly ssm: Pick<SSMClient, "send"> = new SSMClient({}),
    private readonly now: () => number = Date.now,
  ) {}

  private async tryGet(name: string): Promise<string | undefined> {
    try {
      const res = await this.ssm.send(new GetParameterCommand({
        Name: name, WithDecryption: true,
      })) as { Parameter?: { Value?: string } };
      return res.Parameter?.Value;
    } catch (err) {
      if ((err as Error).name === "ParameterNotFound") return undefined;
      throw err;
    }
  }

  async getParam(name: string): Promise<string> {
    const value = await this.tryGet(name);
    if (!value) throw new Error(`missing SSM parameter ${name}`);
    return value;
  }

  async resolve(service: string, agentId: string): Promise<string> {
    const cacheKey = `${service}/${agentId}`;
    const hit = this.cache.get(cacheKey);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.tryGet(`${this.basePath}/${service}/pat/${agentId}`)
      ?? await this.tryGet(`${this.basePath}/${service}/pat`);
    if (!value) {
      throw new ForgeError("not_provisioned",
        `no credential for ${service}; provision this identity first (POST /forge/${service}/provision)`);
    }
    this.cache.set(cacheKey, { value, at: this.now() });
    return value;
  }

  async put(service: string, agentId: string, token: string): Promise<void> {
    await this.ssm.send(new PutParameterCommand({
      Name: `${this.basePath}/${service}/pat/${agentId}`,
      Value: token, Type: "SecureString", Overwrite: true,
    }));
    this.cache.delete(`${service}/${agentId}`);
  }
}
