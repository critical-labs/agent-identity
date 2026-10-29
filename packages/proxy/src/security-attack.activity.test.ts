// Attack tests: attested proxy events embed agent-controlled request strings
// (branch names, repo names). Git refname rules forbid bytes < 0x20 and
// space but ALLOW all non-ASCII, so a branch full of bidi-override or
// zero-width characters — or 8000 chars long — is accepted by a real forge,
// the commit succeeds, and without a central defense the attested event
// lands raw in every fleet feed. These payloads are forge-realistic:
// RealisticForge below enforces git check-ref-format on the branch and each
// test first proves its payload passes that check.
import type { AgentRecord, NoncesRepo } from "@agent-identity/api";
import {
  canonicalString, generateKeypair, sign,
  type ActivityEvent, type BlobSpec, type CommitChangesSpec, type CommitSpec, type RepoRef,
} from "@agent-identity/shared";
import { describe, expect, it, vi } from "vitest";
import { createProxyApp, type ProxyDeps } from "./app.js";
import type { Author, Forge } from "./forge.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const RLO = cp(0x202e);
const ZWSP = cp(0x200b);

// git check-ref-format rules for a branch name, as real forges enforce
// server-side: ASCII control bytes, DEL, space, and ~ ^ : ? * [ \ are
// forbidden; "..", "@{", a leading "." component, a trailing "/" or ".",
// and ".lock" endings are forbidden. Non-ASCII is legal.
const REFNAME_FORBIDDEN = new RegExp(
  `[${cp(0x00)}-${cp(0x1f)}${cp(0x7f)} ~^:?*[\\\\]`,
);
function assertValidRefname(branch: string): void {
  const invalid =
    branch.length === 0 || branch === "@" ||
    REFNAME_FORBIDDEN.test(branch) ||
    branch.includes("..") || branch.includes("@{") || branch.includes("//") ||
    branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") ||
    branch.split("/").some((c) => c.startsWith(".") || c.endsWith(".lock"));
  if (invalid) throw new Error(`forge rejected invalid refname: ${branch}`);
}

class RealisticForge implements Forge {
  async getRepo(_ref: RepoRef, _actor: Author) {
    return { defaultBranch: "main", headSha: "abc123" };
  }
  async createCommit(_ref: RepoRef, spec: CommitSpec, _actor: Author) {
    assertValidRefname(spec.branch);
    return { sha: "c1", url: "https://forge/c1" };
  }
  async putBlob(_ref: RepoRef, _spec: BlobSpec, _actor: Author) {
    return { sha: "blob1" };
  }
  async commitChanges(_ref: RepoRef, spec: CommitChangesSpec, _actor: Author) {
    assertValidRefname(spec.branch);
    return { sha: "c1", url: "https://forge/c1" };
  }
  async openPullRequest() {
    return { number: 7, url: "https://forge/pr/7" };
  }
  async comment() {
    return { id: 9, url: "https://forge/c/9" };
  }
  async fork(ref: RepoRef, _actor: Author) {
    return { owner: "fork-acct", repo: ref.name, defaultBranch: "main" };
  }
  async syncFork(_ref: RepoRef, branch: string, _actor: Author) {
    assertValidRefname(branch);
    return { mergeType: "fast-forward" as const, baseBranch: "critical-labs:main", message: "ok" };
  }
  async repoVisibility(_ref: RepoRef, _actor: Author) {
    return "public" as const;
  }
}

const kp = generateKeypair();

function signed(method: string, path: string, body = "") {
  const timestamp = new Date().toISOString();
  return {
    method,
    body: body || undefined,
    headers: {
      "x-agent-key": kp.publicKeySpkiBase64,
      "x-agent-timestamp": timestamp,
      "x-agent-signature": sign(canonicalString(method, path, timestamp, body), kp.privateKeyPem),
      ...(body ? { "content-type": "application/json" } : {}),
    },
  };
}

const agent: AgentRecord = {
  agentId: "482913", address: "482913@agents.example", publicKey: kp.publicKeySpkiBase64,
  status: "active", createdAt: "t", capabilities: ["github"],
};

function makeAttackDeps() {
  const events: ActivityEvent[] = [];
  const deps: ProxyDeps = {
    agents: { getByFingerprint: vi.fn(async () => agent) } as never,
    nonces: { recordOnce: async () => true } as never as NoncesRepo,
    forges: { github: new RealisticForge() },
    audit: vi.fn(),
    activity: {
      putEvent: async (event: ActivityEvent) => {
        events.push(event);
        return "id";
      },
    },
  };
  return { deps, events };
}

const commitBody = (branch: string) => JSON.stringify({
  owner: "critical-labs", repo: "core", branch,
  message: "m", files: [{ path: "f", content: "x" }],
});

describe("attested proxy events vs forge-realistic hostile branch names", () => {
  const path = "/forge/github/commit";

  it("strips bidi-override and zero-width characters from the attested event", async () => {
    // A real forge accepts this branch: git refname rules allow non-ASCII.
    const branch = `main${RLO}niam${ZWSP}-x`;
    expect(() => assertValidRefname(branch)).not.toThrow();

    const { deps, events } = makeAttackDeps();
    const app = createProxyApp(deps);
    const body = commitBody(branch);
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    // The HIGH-trust attested row must get the same character defense the
    // claimed path gets: no bidi overrides, no zero-width characters —
    // anywhere in the stored event.
    const json = JSON.stringify(events[0]);
    expect(json).not.toContain(RLO);
    expect(json).not.toContain(ZWSP);
    // The event still records the (cleaned) branch coordinates.
    expect(events[0].summary).toContain("critical-labs/core");
  });

  it("caps attested summary/detail lengths against an 8000-char branch", async () => {
    // Also legal per git refname rules: length is unbounded.
    const branch = `wip/${"a".repeat(8000)}`;
    expect(() => assertValidRefname(branch)).not.toThrow();

    const { deps, events } = makeAttackDeps();
    const app = createProxyApp(deps);
    const body = commitBody(branch);
    const res = await app.request(path, { ...signed("POST", path, body), body });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    // Claimed text is capped at 120/500; attested text must be capped too
    // (500), not stored at whatever length the request smuggled in.
    expect(events[0].summary.length).toBeLessThanOrEqual(500);
    for (const value of Object.values(events[0].detail ?? {})) {
      if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(500);
    }
  });
});
