import { describe, expect, it } from "vitest";
import { ForgeError, statusFor } from "./forge.js";

describe("ForgeError", () => {
  it("maps each kind to its HTTP status", () => {
    expect(statusFor("not_found")).toBe(404);
    expect(statusFor("non_fast_forward")).toBe(409);
    expect(statusFor("rate_limited")).toBe(429);
    expect(statusFor("upstream_auth")).toBe(502);
    expect(statusFor("invalid")).toBe(400);
    expect(statusFor("not_provisioned")).toBe(403);
  });

  it("carries kind and optional upstream status", () => {
    const err = new ForgeError("rate_limited", "slow down", 403);
    expect(err.kind).toBe("rate_limited");
    expect(err.upstream).toBe(403);
    expect(err.message).toBe("slow down");
  });
});
