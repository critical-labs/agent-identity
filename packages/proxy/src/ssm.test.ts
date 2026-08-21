import { describe, expect, it, vi } from "vitest";
import { SsmCredentialStore } from "./ssm.js";

/** fake ssm: routes GetParameter by Name; missing names reject like the SDK. */
function makeSsm(params: Record<string, string>) {
  const send = vi.fn(async (cmd: { input: { Name?: string } }) => {
    const name = cmd.input.Name!;
    if (name in params) return { Parameter: { Value: params[name] } };
    const err = new Error("ParameterNotFound");
    err.name = "ParameterNotFound";
    throw err;
  });
  return send;
}

describe("SsmCredentialStore.resolve", () => {
  it("prefers the per-identity parameter", async () => {
    const send = makeSsm({
      "/agent-identity/forge/gitlab/pat/482913": "identity-tok",
      "/agent-identity/forge/gitlab/pat": "shared-tok",
    });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.resolve("gitlab", "482913")).toBe("identity-tok");
  });

  it("falls back to the shared parameter", async () => {
    const send = makeSsm({ "/agent-identity/forge/github/pat": "shared-tok" });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.resolve("github", "482913")).toBe("shared-tok");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("throws not_provisioned when neither exists", async () => {
    const send = makeSsm({});
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    await expect(store.resolve("gitlab", "482913"))
      .rejects.toMatchObject({ kind: "not_provisioned" });
  });

  it("caches within the TTL and refetches after it", async () => {
    const send = makeSsm({ "/agent-identity/forge/github/pat/482913": "tok" });
    let now = 1_000;
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never, () => now);
    await store.resolve("github", "482913");
    now += 60_000;
    await store.resolve("github", "482913");
    expect(send).toHaveBeenCalledTimes(1);
    now += 300_001;
    await store.resolve("github", "482913");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("SsmCredentialStore.put and getParam", () => {
  it("puts a per-identity SecureString with overwrite", async () => {
    const send = vi.fn(async () => ({}));
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    await store.put("gitlab", "482913", "newtok");
    const cmd = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input).toEqual({
      Name: "/agent-identity/forge/gitlab/pat/482913",
      Value: "newtok", Type: "SecureString", Overwrite: true,
    });
  });

  it("getParam reads an arbitrary decrypted parameter", async () => {
    const send = makeSsm({ "/agent-identity/forge/gitlab/admin-token": "admintok" });
    const store = new SsmCredentialStore("/agent-identity/forge", { send } as never);
    expect(await store.getParam("/agent-identity/forge/gitlab/admin-token")).toBe("admintok");
  });
});
