import type { EmailSummary } from "@agent-identity/shared";
import type { ClaimManager } from "./claim-manager.js";

export interface WaitArgs {
  fromContains?: string;
  subjectContains?: string;
  timeoutSeconds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeTools(manager: ClaimManager) {
  return {
    ensureIdentity(args: { require?: string[] } = {}) {
      return manager.ensureIdentity(args.require);
    },

    identityStatus() {
      return manager.status();
    },

    listEmails(opts: { since?: string; limit?: number }) {
      return manager.client().listEmails(opts);
    },

    getEmail(id: string) {
      return manager.client().getEmail(id);
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
        const { emails } = await manager.client().listEmails({ since, limit: 50 });
        const hit = emails.find(matches);
        if (hit) return hit;
        if (Date.now() >= deadline) return { timedOut: true };
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      }
    },
  };
}
