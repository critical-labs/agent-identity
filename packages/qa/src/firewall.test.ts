import { describe, expect, it, vi } from "vitest";
import {
  SOCKETFILTERFW, assertJavaInboundBlocked, firewallFixCommands, parseAppBlocked, parseGlobalState,
} from "./firewall.js";

const JAVA = "/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin/java";

describe("parseGlobalState", () => {
  it.each([
    ["Firewall is enabled. (State = 1) \n", true],
    ["Firewall is enabled. (State = 2)", true],
    ["Firewall is disabled. (State = 0) \n", false],
    ["Firewall is enabled.", true],
    ["", false],
    ["something unexpected", false],
  ])("%j → %s", (out, enabled) => {
    expect(parseGlobalState(out)).toBe(enabled);
  });
});

describe("parseAppBlocked", () => {
  it.each([
    [`Incoming connection to ${JAVA} is blocked \n`, true],
    [`Incoming connection to ${JAVA} is permitted \n`, false],
    ["The application is not part of the firewall \n", false],
    ["", false],
  ])("%j → %s", (out, blocked) => {
    expect(parseAppBlocked(out)).toBe(blocked);
  });
});

describe("firewallFixCommands", () => {
  it("adds and blocks the binary, enabling the firewall first when it is off", () => {
    expect(firewallFixCommands(JAVA, { enabled: false })).toEqual([
      `sudo ${SOCKETFILTERFW} --setglobalstate on`,
      `sudo ${SOCKETFILTERFW} --add ${JAVA}`,
      `sudo ${SOCKETFILTERFW} --blockapp ${JAVA}`,
    ]);
    expect(firewallFixCommands(JAVA, { enabled: true })).toEqual([
      `sudo ${SOCKETFILTERFW} --add ${JAVA}`,
      `sudo ${SOCKETFILTERFW} --blockapp ${JAVA}`,
    ]);
  });

  it("quotes a path the shell would split", () => {
    expect(firewallFixCommands("/opt/My JDK/bin/java", { enabled: true })[0])
      .toBe(`sudo ${SOCKETFILTERFW} --add '/opt/My JDK/bin/java'`);
  });
});

describe("assertJavaInboundBlocked", () => {
  const fw = (global: string, app: string) => vi.fn(async (cmd: string, args: string[]) => {
    expect(cmd).toBe(SOCKETFILTERFW);
    if (args[0] === "--getglobalstate") return { stdout: global, stderr: "" };
    expect(args).toEqual(["--getappblocked", JAVA]);
    return { stdout: app, stderr: "" };
  });

  it("passes on macOS when the firewall is on and blocks the binary", async () => {
    const execFileFn = fw("Firewall is enabled. (State = 1)", `Incoming connection to ${JAVA} is blocked`);
    await expect(assertJavaInboundBlocked(JAVA, { platform: "darwin", execFileFn })).resolves.toBeUndefined();
    expect(execFileFn).toHaveBeenCalledTimes(2);
  });

  it("names the exact commands when the binary is not blocked", async () => {
    const execFileFn = fw("Firewall is enabled. (State = 1)", "The application is not part of the firewall");
    const err = await assertJavaInboundBlocked(JAVA, { platform: "darwin", execFileFn }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`sudo ${SOCKETFILTERFW} --add ${JAVA}`);
    expect((err as Error).message).toContain(`sudo ${SOCKETFILTERFW} --blockapp ${JAVA}`);
    expect((err as Error).message).not.toContain("--setglobalstate");
  });

  it("refuses when the firewall is off, even if the rule exists", async () => {
    const execFileFn = fw("Firewall is disabled. (State = 0)", `Incoming connection to ${JAVA} is blocked`);
    await expect(assertJavaInboundBlocked(JAVA, { platform: "darwin", execFileFn }))
      .rejects.toThrow(`sudo ${SOCKETFILTERFW} --setglobalstate on`);
  });

  it("fails closed when socketfilterfw cannot be run", async () => {
    const execFileFn = vi.fn(async () => { throw new Error("spawn EACCES"); });
    await expect(assertJavaInboundBlocked(JAVA, { platform: "darwin", execFileFn })).rejects.toThrow(/EACCES/);
  });

  it("does not take the override on macOS, where the check is available", async () => {
    const execFileFn = fw("Firewall is disabled. (State = 0)", "The application is not part of the firewall");
    await expect(assertJavaInboundBlocked(JAVA, { platform: "darwin", allowUnfirewalled: true, execFileFn })).rejects.toThrow();
  });

  it("refuses other platforms unless explicitly overridden", async () => {
    const execFileFn = vi.fn();
    await expect(assertJavaInboundBlocked("/usr/bin/java", { platform: "linux", execFileFn }))
      .rejects.toThrow("unsupported platform: bind a host firewall rule for DynamoDB Local and set QA_ALLOW_UNFIREWALLED=1");
    await expect(assertJavaInboundBlocked("/usr/bin/java", { platform: "linux", allowUnfirewalled: true, execFileFn }))
      .resolves.toBeUndefined();
    expect(execFileFn).not.toHaveBeenCalled();
  });
});
