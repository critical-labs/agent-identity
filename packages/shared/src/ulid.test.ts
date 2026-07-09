import { describe, expect, it } from "vitest";
import { encodeTime, ulid } from "./ulid.js";

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
