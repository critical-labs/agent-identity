import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateProfile } from "./profile.js";

describe("profile", () => {
  it("creates a keypair file with mode 0600, then reloads the same keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "aid-"));
    const p1 = loadOrCreateProfile("default", dir);
    const p2 = loadOrCreateProfile("default", dir);
    expect(p1.publicKeySpkiBase64).toBe(p2.publicKeySpkiBase64);
    const mode = statSync(join(dir, "default.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
  it("different profiles get different keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "aid-"));
    const a = loadOrCreateProfile("a", dir);
    const b = loadOrCreateProfile("b", dir);
    expect(a.publicKeySpkiBase64).not.toBe(b.publicKeySpkiBase64);
  });
});
