import {
  canonicalString, sign, type AgentIdentity, type EmailFull,
  type EmailSummary, type Keypair,
} from "@agent-identity/shared";

export interface ClientOptions {
  apiUrl: string;
  keypair: Keypair;
  fleetKey?: string;
  fetch?: typeof globalThis.fetch;
}

export class AgentIdentityClient {
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  private async request<T>(method: string, pathWithQuery: string, body = "", extra: Record<string, string> = {}): Promise<T> {
    const timestamp = new Date().toISOString();
    const signature = sign(
      canonicalString(method, pathWithQuery, timestamp, body),
      this.opts.keypair.privateKeyPem,
    );
    const res = await this.fetchFn(`${this.opts.apiUrl}${pathWithQuery}`, {
      method,
      body: body || undefined,
      headers: {
        "x-agent-key": this.opts.keypair.publicKeySpkiBase64,
        "x-agent-timestamp": timestamp,
        "x-agent-signature": signature,
        ...(body ? { "content-type": "application/json" } : {}),
        ...extra,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  register(): Promise<AgentIdentity> {
    return this.request("POST", "/register", "",
      this.opts.fleetKey ? { "x-fleet-key": this.opts.fleetKey } : {});
  }

  me(): Promise<AgentIdentity> {
    return this.request("GET", "/me");
  }

  listEmails(opts: { since?: string; limit?: number; cursor?: string } = {}):
    Promise<{ emails: EmailSummary[]; cursor?: string }> {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", opts.since);
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return this.request("GET", `/emails${qs ? `?${qs}` : ""}`);
  }

  getEmail(id: string): Promise<EmailFull> {
    return this.request("GET", `/emails/${id}`);
  }
}
