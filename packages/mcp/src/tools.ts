import type { AgentIdentityClient } from "@agent-identity/client";
import type { AgentIdentity, EmailSummary } from "@agent-identity/shared";

export interface WaitArgs {
  fromContains?: string;
  subjectContains?: string;
  timeoutSeconds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeTools(
  client: AgentIdentityClient,
  persistIdentity: (id: AgentIdentity) => void,
) {
  return {
    async ensureIdentity(): Promise<AgentIdentity> {
      const identity = await client.register();
      persistIdentity(identity);
      return identity;
    },

    listEmails(opts: { since?: string; limit?: number }) {
      return client.listEmails(opts);
    },

    getEmail(id: string) {
      return client.getEmail(id);
    },

    async waitForEmail(
      args: WaitArgs, opts: { pollMs?: number } = {},
    ): Promise<EmailSummary | { timedOut: true }> {
      const pollMs = opts.pollMs ?? 5000;
      const deadline = Date.now() + args.timeoutSeconds * 1000;
      // 15-minute lookback: the email often arrives before polling starts,
      // e.g. while a human finishes a signup form the agent asked them to fill.
      const since = new Date(Date.now() - 900_000).toISOString();
      const matches = (e: EmailSummary) =>
        (!args.fromContains || e.from.toLowerCase().includes(args.fromContains.toLowerCase())) &&
        (!args.subjectContains || e.subject.toLowerCase().includes(args.subjectContains.toLowerCase()));
      for (;;) {
        const { emails } = await client.listEmails({ since, limit: 50 });
        const hit = emails.find(matches);
        if (hit) return hit;
        if (Date.now() >= deadline) return { timedOut: true };
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      }
    },
  };
}
