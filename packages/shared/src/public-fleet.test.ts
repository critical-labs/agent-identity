// Public fleet tier: the operator's rule, verbatim — "I want a public view
// of agents, but only when they are working on public repos; private repos
// like homefree should never be mentioned publicly." Fail-closed is the law:
// when in doubt, the public tier shows NOTHING. These tests therefore assert
// on JSON.stringify of whole projections, not just on individual fields —
// absence must hold for the serialized bytes a client would receive.
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./activity.js";
import {
  parseRepoAllowlist, publicView, repoMatchesAllowlist,
} from "./public-fleet.js";

const ALLOW = parseRepoAllowlist("critical-labs/*,acme/widgets");

const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
  agentId: "482913", ts: "2026-09-23T12:00:00.000Z", class: "attested",
  type: "forge_commit", summary: "s", ...over,
});

describe("parseRepoAllowlist", () => {
  it("parses comma-separated owner/repo and owner/* patterns, trimming whitespace", () => {
    expect(parseRepoAllowlist(" critical-labs/* , acme/widgets "))
      .toEqual(["critical-labs/*", "acme/widgets"]);
  });

  it("lowercases patterns", () => {
    expect(parseRepoAllowlist("Critical-Labs/Agent-Identity"))
      .toEqual(["critical-labs/agent-identity"]);
  });

  it("empty string parses to the empty allowlist", () => {
    expect(parseRepoAllowlist("")).toEqual([]);
    expect(parseRepoAllowlist("  ")).toEqual([]);
    expect(parseRepoAllowlist(" , ,")).toEqual([]);
  });

  it("drops malformed patterns instead of widening them (fail-closed)", () => {
    for (const bad of [
      "*",            // bare wildcard
      "*/*",          // wildcard owner
      "*/repo",       // wildcard owner
      "owner/re*",    // partial wildcard
      "own*er/repo",  // wildcard inside owner
      "owner/",       // empty repo
      "/repo",        // empty owner
      "owner",        // no repo segment
      "a/b/c",        // extra segment
      "..",           // dot games
      "../*",
      "owner/..",
      "ow ner/repo",  // whitespace inside a segment
      "owner/répo",   // outside the forge charset
    ]) {
      expect(parseRepoAllowlist(bad), bad).toEqual([]);
    }
  });
});

describe("repoMatchesAllowlist", () => {
  it("matches exact owner/repo case-insensitively", () => {
    expect(repoMatchesAllowlist("acme/widgets", ALLOW)).toBe(true);
    expect(repoMatchesAllowlist("Acme/Widgets", ALLOW)).toBe(true);
  });

  it("matches owner/* for any repo of that exact owner", () => {
    expect(repoMatchesAllowlist("critical-labs/anything", ALLOW)).toBe(true);
    expect(repoMatchesAllowlist("CRITICAL-LABS/Thing", ALLOW)).toBe(true);
  });

  it("never matches evil owner prefixes or suffixes (exact segment matching)", () => {
    expect(repoMatchesAllowlist("critical-labs-evil/x", ALLOW)).toBe(false);
    expect(repoMatchesAllowlist("xcritical-labs/x", ALLOW)).toBe(false);
    expect(repoMatchesAllowlist("evil/critical-labs", ALLOW)).toBe(false);
    expect(repoMatchesAllowlist("acme/widgets-evil", ALLOW)).toBe(false);
    expect(repoMatchesAllowlist("acme/xwidgets", ALLOW)).toBe(false);
  });

  it("never matches candidates with missing or extra path segments", () => {
    expect(repoMatchesAllowlist("acme", ALLOW)).toBe(false);
    expect(repoMatchesAllowlist("acme/widgets/sub", ALLOW)).toBe(false);
    expect(repoMatchesAllowlist("critical-labs/x/y", ALLOW)).toBe(false);
    expect(repoMatchesAllowlist("acme/", ALLOW)).toBe(false);
    expect(repoMatchesAllowlist("/widgets", ALLOW)).toBe(false);
  });

  it("empty allowlist matches nothing", () => {
    expect(repoMatchesAllowlist("acme/widgets", [])).toBe(false);
  });

  it("non-string candidates never match", () => {
    expect(repoMatchesAllowlist(42 as never, ALLOW)).toBe(false);
    expect(repoMatchesAllowlist(undefined as never, ALLOW)).toBe(false);
  });

  it("re-validates patterns at match time: raw garbage handed in as a pattern grants nothing", () => {
    expect(repoMatchesAllowlist("anything/at-all", ["*", "*/*", "a/b/c", ""])).toBe(false);
  });
});

describe("publicView — forge events", () => {
  it("includes forge events only for allowlisted repos; private repos are ABSENT from the serialized output", () => {
    const events = [
      ev({ type: "forge_commit", summary: "committed to critical-labs/core@main",
        detail: { service: "github", repo: "critical-labs/core", branch: "main", sha: "abc", visibility: "public" },
        ref: "https://github.com/critical-labs/core/commit/abc" }),
      ev({ type: "forge_commit", summary: "committed to mc/homefree@main",
        detail: { service: "github", repo: "mc/homefree", branch: "main", sha: "def", visibility: "public" },
        ref: "https://github.com/mc/homefree/commit/def" }),
    ];
    const view = publicView(events, [], ALLOW);
    expect(view.events).toHaveLength(1);
    const s = JSON.stringify(view);
    expect(s).not.toContain("homefree");
    expect(s).not.toContain("def");
    expect(s).toContain("critical-labs/core");
  });

  it("excluded events leave no placeholder, count, or tempo signal", () => {
    const events = [
      ev({ type: "forge_pr", detail: { service: "github", repo: "mc/homefree", number: 7, visibility: "public" } }),
      ev({ type: "forge_comment", detail: { service: "github", repo: "mc/homefree", issue: 1, visibility: "public" } }),
    ];
    const view = publicView(events, [], ALLOW);
    expect(view.events).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/homefree|redacted|private|excluded/i);
  });

  it("empty allowlist shows no forge events at all", () => {
    const events = [
      ev({ type: "forge_commit", detail: { service: "github", repo: "critical-labs/core", branch: "m", sha: "a", visibility: "public" } }),
    ];
    expect(publicView(events, [], []).events).toEqual([]);
  });

  it("drops forge events with no repo-shaped detail (fail-closed)", () => {
    expect(publicView([ev({ type: "forge_commit" })], [], ALLOW).events).toEqual([]);
    expect(publicView([ev({ type: "forge_commit", detail: { service: "github", visibility: "public" } })], [], ALLOW).events).toEqual([]);
  });

  it("drops a claimed event laundered with a forge type, even for an allowlisted repo", () => {
    const events = [ev({
      class: "claimed", type: "forge_commit",
      detail: { service: "github", repo: "critical-labs/core", branch: "m", sha: "a", visibility: "public" },
    })];
    expect(publicView(events, [], ALLOW).events).toEqual([]);
  });

  it("forge_fork requires BOTH source and fork to be allowlisted", () => {
    const fork = (source: string, target: string) => ev({
      type: "forge_fork", summary: `forked ${source} to ${target}`,
      detail: { service: "github", source, fork: target, visibility: "public" },
    });
    expect(publicView([fork("critical-labs/core", "critical-labs/core-fork")], [], ALLOW).events).toHaveLength(1);
    // fork landed in a non-allowlisted account: the whole event is absent
    const view = publicView([fork("critical-labs/core", "bot-7/core")], [], ALLOW);
    expect(view.events).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("bot-7");
  });

  it("forge_sync names only the fork and never carries a ref", () => {
    const sync = (fork: string, visibility = "public") => ev({
      type: "forge_sync", summary: `synced ${fork}@main from upstream (fast-forward)`,
      detail: { service: "github", fork, branch: "main", mergeType: "fast-forward", visibility },
      ref: "https://github.com/critical-labs/core-fork",
    });
    const view = publicView([sync("critical-labs/core-fork")], [], ALLOW);
    expect(view.events).toHaveLength(1);
    expect(view.events[0]).toEqual(expect.objectContaining({
      type: "forge_sync",
      detail: { service: "github", fork: "critical-labs/core-fork", branch: "main", mergeType: "fast-forward" },
    }));
    expect(view.events[0]!.ref).toBeUndefined();
    expect(publicView([sync("bot-7/core")], [], ALLOW).events).toEqual([]);
    // An allowlisted fork the forge stamped private stays out, as for every
    // other forge type — the stamp, not the name, is what admits an event.
    expect(publicView([sync("critical-labs/core-fork", "private")], [], ALLOW).events).toEqual([]);
  });

  it("strips detail fields outside the per-type allowlist", () => {
    const events = [ev({
      type: "forge_commit",
      detail: {
        service: "github", repo: "critical-labs/core", branch: "m", sha: "a", visibility: "public",
        stray: "mc/homefree", operatorEmail: "op@example.com",
      },
    })];
    const s = JSON.stringify(publicView(events, [], ALLOW));
    expect(s).not.toContain("homefree");
    expect(s).not.toContain("op@example.com");
    expect(s).not.toContain("stray");
  });
});

describe("publicView — forge visibility gate", () => {
  const commitTo = (repo: string, extra: Record<string, string | number | boolean> = {}) => ev({
    detail: { service: "github", repo, branch: "m", sha: "a", ...extra },
  });

  it("requires the proxy's attestation-time stamp: detail.visibility === 'public'", () => {
    expect(publicView([commitTo("critical-labs/core", { visibility: "public" })], [], ALLOW)
      .events).toHaveLength(1);
  });

  it("drops an allowlisted-name event whose visibility stamp is missing — pre-stamp history stays private", () => {
    expect(publicView([commitTo("critical-labs/core")], [], ALLOW).events).toEqual([]);
  });

  it("drops 'private' and anything that is not the exact string 'public'", () => {
    for (const bad of ["private", "internal", "PUBLIC", true] as const) {
      expect(publicView([commitTo("critical-labs/core", { visibility: bad as never })], [], ALLOW)
        .events, JSON.stringify(bad)).toEqual([]);
    }
  });

  it("gates every forge type, fork included", () => {
    const fork = ev({
      type: "forge_fork",
      detail: { service: "github", source: "critical-labs/core", fork: "critical-labs/core-fork" },
    });
    expect(publicView([fork], [], ALLOW).events).toEqual([]);
    expect(publicView([{ ...fork, detail: { ...fork.detail, visibility: "public" } }], [], ALLOW)
      .events).toHaveLength(1);
  });

  it("the stamp is a gate, not payload: 'visibility' is absent from the public output", () => {
    const view = publicView([commitTo("critical-labs/core", { visibility: "public" })], [], ALLOW);
    expect(view.events).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("visibility");
  });
});

describe("publicView — ref re-validation", () => {
  const commit = (ref?: string) => ev({
    type: "forge_commit",
    detail: { service: "github", repo: "critical-labs/core", branch: "m", sha: "a", visibility: "public" },
    ...(ref !== undefined ? { ref } : {}),
  });

  it("keeps a github.com/gitlab.com ref whose path sits under the event's allowlisted repo", () => {
    expect(publicView([commit("https://github.com/critical-labs/core/commit/a")], [], ALLOW)
      .events[0]?.ref).toBe("https://github.com/critical-labs/core/commit/a");
    expect(publicView([commit("https://gitlab.com/critical-labs/core/-/commit/a")], [], ALLOW)
      .events[0]?.ref).toBe("https://gitlab.com/critical-labs/core/-/commit/a");
  });

  it("drops refs on any other origin — the event survives without the ref", () => {
    for (const bad of [
      "https://github.com.evil.com/critical-labs/core/commit/a",
      "https://evilgithub.com/critical-labs/core/commit/a",
      "https://evil.com/https://github.com/critical-labs/core",
      "http://github.com/critical-labs/core/commit/a",
      "javascript:alert(1)//github.com/critical-labs/core",
      "https://github.com:8443/critical-labs/core/commit/a",
      "https://github.com@evil.com/critical-labs/core/commit/a",
    ]) {
      const view = publicView([commit(bad)], [], ALLOW);
      expect(view.events, bad).toHaveLength(1);
      expect(JSON.stringify(view), bad).not.toContain("ref");
    }
  });

  it("drops refs whose path escapes the repo prefix at a segment boundary", () => {
    for (const bad of [
      "https://github.com/critical-labs/core-evil/commit/a", // suffix trick
      "https://github.com/critical-labsx/core/commit/a",
      "https://github.com/mc/homefree/commit/a",             // different repo entirely
      "https://github.com/critical-labs",                    // owner page, not the repo
    ]) {
      const view = publicView([commit(bad)], [], ALLOW);
      expect(view.events, bad).toHaveLength(1);
      expect(view.events[0], bad).not.toHaveProperty("ref");
    }
  });

  it("a bare repo-root ref and a malformed ref behave correctly", () => {
    expect(publicView([commit("https://github.com/critical-labs/core")], [], ALLOW)
      .events[0]?.ref).toBe("https://github.com/critical-labs/core");
    expect(publicView([commit("not a url")], [], ALLOW).events[0]).not.toHaveProperty("ref");
  });
});

describe("publicView — claimed events", () => {
  it("status events pass with state + ts only; the label is absent from the serialized output", () => {
    const events = [ev({
      class: "claimed", type: "status",
      summary: "status: working — fixing homefree billing bug",
      detail: { state: "working", label: "fixing homefree billing bug" },
    })];
    const view = publicView(events, [], ALLOW);
    expect(view.events).toEqual([{
      agentId: "482913", ts: "2026-09-23T12:00:00.000Z", class: "claimed",
      type: "status", summary: "status: working", detail: { state: "working" },
    }]);
    const s = JSON.stringify(view);
    expect(s).not.toContain("homefree");
    expect(s).not.toContain("label");
  });

  it("drops status events with an unknown state, and attested-classed status rows", () => {
    expect(publicView([ev({ class: "claimed", type: "status", detail: { state: "napping" } })], [], ALLOW)
      .events).toEqual([]);
    expect(publicView([ev({ class: "attested", type: "status", detail: { state: "working" } })], [], ALLOW)
      .events).toEqual([]);
  });

  it("task_note events are dropped entirely", () => {
    const view = publicView(
      [ev({ class: "claimed", type: "task_note", summary: "migrating homefree secrets" })],
      [], ALLOW,
    );
    expect(view.events).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("homefree");
  });
});

describe("publicView — email and other attested events", () => {
  const mail = (senderDomain: string) => ev({
    type: "email_received", summary: `email received from ${senderDomain}`,
    detail: { senderDomain },
  });

  it("keeps email_received only for github.com/gitlab.com or their subdomains (label boundary)", () => {
    expect(publicView([mail("github.com")], [], ALLOW).events).toHaveLength(1);
    expect(publicView([mail("GitHub.com")], [], ALLOW).events).toHaveLength(1);
    expect(publicView([mail("mail.gitlab.com")], [], ALLOW).events).toHaveLength(1);
    for (const bad of [
      "github.com.evil.com", "evilgithub.com", "xgitlab.com",
      "github.org", "example.org", ".github.com", "",
    ]) {
      const view = publicView([mail(bad)], [], ALLOW);
      expect(view.events, bad).toEqual([]);
    }
  });

  it("non-forge sender domains are absent from the serialized output", () => {
    const s = JSON.stringify(publicView([mail("secret-partner.example")], [], ALLOW));
    expect(s).not.toContain("secret-partner.example");
  });

  it("drops capability_granted and unknown event types (fail-closed)", () => {
    expect(publicView([ev({ type: "capability_granted", summary: "provisioned a github service account", detail: { service: "github" } })], [], ALLOW).events).toEqual([]);
    expect(publicView([ev({ type: "new_shiny_type" as never, summary: "x" })], [], ALLOW).events).toEqual([]);
  });
});

describe("publicView — roster", () => {
  it("projects agentId, capabilities, status state + staleness; label and updatedAt are absent", () => {
    const roster = [{
      agentId: "482913", capabilities: ["github"],
      status: { state: "working" as const, label: "homefree deploy", updatedAt: "2026-09-23T11:59:00Z", stale: false },
      counts: { attested: 100, claimed: 40 },
    }];
    const view = publicView([], roster, ALLOW);
    expect(view.agents).toEqual([{
      agentId: "482913", capabilities: ["github"],
      status: { state: "working", stale: false },
      counts: { attested: 0, claimed: 0 },
    }]);
    const s = JSON.stringify(view);
    expect(s).not.toContain("homefree");
    expect(s).not.toContain("label");
    expect(s).not.toContain("updatedAt");
  });

  it("recomputes counts over PUBLIC events only: 100 private events show as 0", () => {
    const roster = [{ agentId: "482913", capabilities: [], counts: { attested: 100, claimed: 40 } }];
    const privateEvents = Array.from({ length: 100 }, (_, i) => ev({
      type: "forge_commit", detail: { service: "github", repo: "mc/homefree", branch: "m", sha: `s${i}` },
    }));
    const view = publicView(privateEvents, roster, ALLOW);
    expect(view.agents[0].counts).toEqual({ attested: 0, claimed: 0 });
    expect(JSON.stringify(view)).not.toContain("homefree");
  });

  it("counts public events per class for the owning agent", () => {
    const roster = [
      { agentId: "482913", capabilities: [] },
      { agentId: "700001", capabilities: [] },
    ];
    const events = [
      ev({ type: "forge_commit", detail: { service: "github", repo: "acme/widgets", branch: "m", sha: "a", visibility: "public" } }),
      ev({ class: "claimed", type: "status", detail: { state: "idle" } }),
      ev({ agentId: "700001", type: "forge_pr", detail: { service: "github", repo: "mc/homefree", number: 1 } }),
    ];
    const view = publicView(events, roster, ALLOW);
    expect(view.agents.find((a) => a.agentId === "482913")?.counts).toEqual({ attested: 1, claimed: 1 });
    expect(view.agents.find((a) => a.agentId === "700001")?.counts).toEqual({ attested: 0, claimed: 0 });
  });

  it("an agent with no status row projects without a status key", () => {
    const view = publicView([], [{ agentId: "482913", capabilities: [] }], ALLOW);
    expect(view.agents[0]).not.toHaveProperty("status");
  });
});
