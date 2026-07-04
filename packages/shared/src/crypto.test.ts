import { describe, expect, it } from "vitest";
import {
  canonicalString, fingerprint, generateKeypair, sign, verify,
} from "./crypto.js";

describe("crypto", () => {
  it("round-trips sign/verify with generated keypair", () => {
    const kp = generateKeypair();
    const msg = canonicalString("GET", "/emails?limit=5", "2026-07-04T00:00:00Z", "");
    const sig = sign(msg, kp.privateKeyPem);
    expect(verify(msg, sig, kp.publicKeySpkiBase64)).toBe(true);
    expect(verify(msg + "x", sig, kp.publicKeySpkiBase64)).toBe(false);
  });
  it("fingerprint is stable 64-hex of the public key", () => {
    const kp = generateKeypair();
    const fp = fingerprint(kp.publicKeySpkiBase64);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(kp.publicKeySpkiBase64)).toBe(fp);
  });
  it("canonicalString hashes the body", () => {
    const a = canonicalString("POST", "/register", "t", "");
    const b = canonicalString("POST", "/register", "t", "{}");
    expect(a).not.toBe(b);
    expect(a.split("\n")).toHaveLength(4);
  });
});
