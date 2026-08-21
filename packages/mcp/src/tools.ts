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

    async forgeRepo(args: { service?: string; owner: string; repo: string }) {
      try {
        return await manager.client().forgeRepo(args.service ?? "github",
          { owner: args.owner, name: args.repo });
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    async forgeCommit(args: {
      service?: string; owner: string; repo: string; branch: string;
      message: string; files: { path: string; content: string }[];
    }) {
      try {
        return await manager.client().forgeCommit(args.service ?? "github",
          { owner: args.owner, name: args.repo },
          { branch: args.branch, message: args.message, files: args.files });
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    async forgeOpenPr(args: {
      service?: string; owner: string; repo: string;
      head: string; base: string; title: string; body: string;
    }) {
      try {
        return await manager.client().forgeOpenPr(args.service ?? "github",
          { owner: args.owner, name: args.repo },
          { head: args.head, base: args.base, title: args.title, body: args.body });
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    async forgeComment(args: {
      service?: string; owner: string; repo: string; issue: number; body: string;
    }) {
      try {
        return await manager.client().forgeComment(args.service ?? "github",
          { owner: args.owner, name: args.repo }, args.issue, args.body);
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    async forgeProvision(args: { service?: string }) {
      try {
        return await manager.client().forgeProvision(args.service ?? "gitlab");
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}
