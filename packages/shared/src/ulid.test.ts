import { describe, expect, it } from "vitest";
import { deterministicUlid, encodeTime, ulid } from "./ulid.js";

describe("ulid", () => {
  it("is 26 chars of Crockford base32", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("sorts by time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a < b).toBe(true);
  });
  it("encodeTime is deterministic 10-char prefix", () => {
    expect(encodeTime(0)).toBe("0000000000");
    expect(ulid(123456789).startsWith(encodeTime(123456789))).toBe(true);
  });
});

describe("deterministicUlid", () => {
  it("same (ms, seed) produces identical output twice", () => {
    const a = deterministicUlid(1000, "ses-message-id-abc");
    const b = deterministicUlid(1000, "ses-message-id-abc");
    expect(a).toBe(b);
  });

  it("different seeds produce different tails", () => {
    const a = deterministicUlid(1000, "seed-one");
    const b = deterministicUlid(1000, "seed-two");
    expect(a.slice(10)).not.toBe(b.slice(10));
  });

  it("output is 26 chars from Crockford base32 alphabet", () => {
    expect(deterministicUlid(123456789, "some-seed")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("first 10 chars equal encodeTime(ms)", () => {
    const ms = 1751673600000;
    expect(deterministicUlid(ms, "any-seed").slice(0, 10)).toBe(encodeTime(ms));
  });
});
