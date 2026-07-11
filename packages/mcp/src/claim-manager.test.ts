import { savePoolProfile } from "@agent-identity/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaimManager, NoIdentityError } from "./claim-manager.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-mgr-"));

const profile = (agentId: string, github?: { username: string }) => ({
  publicKeySpkiBase64: `pk-${agentId}`,
  privateKeyPem: `sk-${agentId}`,
  agentId,
  address: `${agentId}@d`,
  ...(github ? { github } : {}),
});

// Fake client factory: register() echoes back an identity derived from the keypair.
function fakeFactory(registered: string[] = []) {
  return vi.fn((keypair: { publicKeySpkiBase64: string }) => {
    const id = keypair.publicKeySpkiBase64.startsWith("pk-")
      ? keypair.publicKeySpkiBase64.slice(3)
      : "555555"; // fresh keypair created by auto-create
    return {
      register: vi.fn(async () => {
        registered.push(id);
        return { agentId: id, address: `${id}@d` };
      }),
      listEmails: vi.fn(async () => ({ emails: [] })),
      getEmail: vi.fn(async () => ({ id: "e", from: "f", subject: "s", receivedAt: "t", text: "", links: [] })),
    };
  });
}

describe("ClaimManager", () => {
  it("init claims a free pool profile and client() works", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    expect(mgr.status().held?.name).toBe("111111");
    expect(mgr.client()).toBeDefined();
    mgr.release();
  });

  it("init with empty pool auto-creates, registers, and claims a new profile", async () => {
    const dir = base();
    const registered: string[] = [];
    const mgr = new ClaimManager({
      base: dir, fleetKey: "fk", makeClient: fakeFactory(registered) as never,
    });
    await mgr.init();
    expect(registered).toEqual(["555555"]);
    expect(mgr.status().held?.agentId).toBe("555555");
    expect(mgr.status().pool.total).toBe(1); // saved into the pool
    mgr.release();
  });

  it("init with require github and none free stores the error; tools throw NoIdentityError", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir); // plain only
    const mgr = new ClaimManager({
      base: dir, require: ["github"], makeClient: fakeFactory() as never,
    });
    await mgr.init(); // must not throw
    expect(mgr.status().held).toBeNull();
    expect(() => mgr.client()).toThrow(NoIdentityError);
    await expect(mgr.ensureIdentity()).rejects.toThrow(/no free identity with capabilities \[github\]/);
  });

  it("ensureIdentity registers, persists identity, and is idempotent", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    expect(await mgr.ensureIdentity()).toEqual({ agentId: "111111", address: "111111@d" });
    expect(await mgr.ensureIdentity()).toEqual({ agentId: "111111", address: "111111@d" });
    mgr.release();
  });

  it("ensureIdentity({require:[github]}) swaps to a qualifying profile and frees the old one", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    savePoolProfile(profile("222222", { username: "x" }), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    expect(mgr.status().held?.name).toBe("111111");
    expect(await mgr.ensureIdentity(["github"])).toEqual({ agentId: "222222", address: "222222@d" });
    expect(mgr.status().held?.name).toBe("222222");
    expect(mgr.status().pool.freeByCapability).toEqual({}); // github one now held
    // old profile is free again:
    const mgr2 = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr2.init();
    expect(mgr2.status().held?.name).toBe("111111");
    mgr.release();
    mgr2.release();
  });

  it("failed swap keeps the current claim", async () => {
    const dir = base();
    savePoolProfile(profile("111111"), dir);
    const mgr = new ClaimManager({ base: dir, makeClient: fakeFactory() as never });
    await mgr.init();
    await expect(mgr.ensureIdentity(["github"])).rejects.toThrow(NoIdentityError);
    expect(mgr.status().held?.name).toBe("111111");
    mgr.release();
  });
});
