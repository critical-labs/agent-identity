import { describe, expect, it } from "vitest";
import { buildDeps } from "./deps.js";

const ddb = {} as never;
const readBody = async () => ({ text: "", links: [] });
const base = { TABLE_NAME: "t", MAIL_DOMAIN: "mail.example.com" };

describe("buildDeps", () => {
  it("applies the deployed defaults (fleet key on, public tier and auto-capabilities off)", () => {
    const d = buildDeps({ env: base, ddb, readBody });
    expect(d.fleetKeyRequired).toBe(true);
    expect(d.publicRepos).toEqual([]);
    expect(d.autoCapabilities).toEqual([]);
    expect(d.mailDomain).toBe("mail.example.com");
    expect(d.readBody).toBe(readBody);
  });

  it("turns the fleet key off only for exactly 'false'", () => {
    expect(buildDeps({ env: { ...base, FLEET_KEY_REQUIRED: "false" }, ddb, readBody }).fleetKeyRequired).toBe(false);
    expect(buildDeps({ env: { ...base, FLEET_KEY_REQUIRED: "no" }, ddb, readBody }).fleetKeyRequired).toBe(true);
  });

  it("parses PUBLIC_REPOS and AUTO_CAPABILITIES", () => {
    const d = buildDeps({ env: { ...base, PUBLIC_REPOS: "Acme/Widget", AUTO_CAPABILITIES: " github, ,x " }, ddb, readBody });
    expect(d.publicRepos).toEqual(["acme/widget"]);
    expect(d.autoCapabilities).toEqual(["github", "x"]);
  });

  it("requires TABLE_NAME and MAIL_DOMAIN", () => {
    expect(() => buildDeps({ env: { MAIL_DOMAIN: "d" }, ddb, readBody })).toThrow(/TABLE_NAME/);
    expect(() => buildDeps({ env: { TABLE_NAME: "t" }, ddb, readBody })).toThrow(/MAIL_DOMAIN/);
  });
});
