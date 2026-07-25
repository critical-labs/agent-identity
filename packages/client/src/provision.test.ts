import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPool } from "./claims.js";
import { provisionIdentities } from "./provision.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-prov-"));

// Fake factory: register() returns sequential identities; ids 900000+n.
function fakeFactory(failOn: number[] = []) {
  let n = 0;
  return () => {
    const i = n++;
    return {
      register: async () => {
        if (failOn.includes(i)) throw new Error(`boom ${i}`);
        return { agentId: `90000${i}`, address: `90000${i}@d` };
      },
    };
  };
}

describe("provisionIdentities", () => {
  it("mints count identities into the pool", async () => {
    const dir = base();
    const results = await provisionIdentities({
      count: 3, apiUrl: "https://api", fleetKey: "fk", base: dir,
      makeClient: fakeFactory(),
    });
    expect(results).toEqual([
      { agentId: "900000", address: "900000@d" },
      { agentId: "900001", address: "900001@d" },
      { agentId: "900002", address: "900002@d" },
    ]);
    expect(listPool(dir).map((p) => p.name)).toEqual(["900000", "900001", "900002"]);
  });

  it("continues past failures and reports them per identity", async () => {
    const dir = base();
    const results = await provisionIdentities({
      count: 3, apiUrl: "https://api", fleetKey: "fk", base: dir,
      makeClient: fakeFactory([1]),
    });
    expect(results[0]).toEqual({ agentId: "900000", address: "900000@d" });
    expect(results[1]).toEqual({ error: "boom 1" });
    expect(results[2]).toEqual({ agentId: "900002", address: "900002@d" });
    expect(listPool(dir)).toHaveLength(2);
  });
});
