import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasCapabilities, linkGithub, listPool, poolDir, savePoolProfile,
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
