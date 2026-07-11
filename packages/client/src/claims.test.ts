import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimFromPool, claimSpecific, hasCapabilities, linkGithub, listPool, poolDir, savePoolProfile,
  type PoolProfile,
} from "./claims.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-claims-"));

const profile = (agentId: string, github?: { username: string }): PoolProfile & { agentId: string } => ({
  publicKeySpkiBase64: `pk-${agentId}`,
  privateKeyPem: `sk-${agentId}`,
  agentId,
  address: `${agentId}@d`,
  ...(github ? { github } : {}),
});

describe("pool primitives", () => {
  it("listPool returns [] when pool dir does not exist", () => {
    expect(listPool(base())).toEqual([]);
  });

  it("savePoolProfile names the file by agentId and listPool reads it back", () => {
    const dir = base();
    const name = savePoolProfile(profile("111111"), dir);
    expect(name).toBe("111111");
    const pool = listPool(dir);
    expect(pool).toHaveLength(1);
    expect(pool[0].name).toBe("111111");
    expect(pool[0].profile.address).toBe("111111@d");
  });

  it("listPool skips corrupt profile files", () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    writeFileSync(join(poolDir(dir), "bad.json"), "{nope");
    expect(listPool(dir).map((p) => p.name)).toEqual(["111111"]);
  });

  it("hasCapabilities: github requires a github block; unknown caps never match", () => {
    expect(hasCapabilities(profile("1"), [])).toBe(true);
    expect(hasCapabilities(profile("1"), ["github"])).toBe(false);
    expect(hasCapabilities(profile("1", { username: "x" }), ["github"])).toBe(true);
    expect(hasCapabilities(profile("1", { username: "x" }), ["gitlab"])).toBe(false);
  });

  it("linkGithub writes the github block into an existing pool profile", () => {
    const dir = base();
    savePoolProfile(profile("222222"), dir);
    linkGithub("222222", { username: "critical-agent-two", credentialRef: "op://x" }, dir);
    const saved = JSON.parse(readFileSync(join(poolDir(dir), "222222.json"), "utf8"));
    expect(saved.github).toEqual({ username: "critical-agent-two", credentialRef: "op://x" });
  });

  it("linkGithub throws a clear error for a missing profile", () => {
    expect(() => linkGithub("999999", { username: "x" }, base()))
      .toThrow(/no pool profile named 999999/);
  });
});

describe("claiming", () => {
  it("claims the lexicographically first free matching profile", async () => {
    const dir = base();
    savePoolProfile(profile("222222"), dir);
    savePoolProfile(profile("111111"), dir);
    const claim = await claimFromPool({ base: dir });
    expect(claim?.name).toBe("111111");
  });

  it("two claims from the same pool get different profiles", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222"), dir);
    const a = await claimFromPool({ base: dir });
    const b = await claimFromPool({ base: dir });
    expect(a?.name).toBe("111111");
    expect(b?.name).toBe("222222");
  });

  it("returns undefined when everything is claimed by live pids", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    await claimFromPool({ base: dir });
    expect(await claimFromPool({ base: dir })).toBeUndefined();
  });

  it("release makes the profile claimable again", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const a = await claimFromPool({ base: dir });
    a!.release();
    expect((await claimFromPool({ base: dir }))?.name).toBe("111111");
  });

  it("respects capability requirements", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222", { username: "x" }), dir);
    const claim = await claimFromPool({ base: dir, require: ["github"] });
    expect(claim?.name).toBe("222222");
  });

  it("excludes named profiles (used by swap)", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const claim = await claimFromPool({ base: dir, exclude: ["111111"] });
    expect(claim).toBeUndefined();
  });

  it("claimSpecific claims exactly the named profile", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222"), dir);
    const claim = await claimSpecific("222222", { base: dir });
    expect(claim?.name).toBe("222222");
    expect(await claimSpecific("222222", { base: dir })).toBeUndefined();
  });
});
