// DynamoDB Local has no bind option: it listens on every interface, and each
// pane's emulator holds redacted but real fleet data. So `pnpm qa` refuses to
// start unless the host firewall blocks inbound connections to the exact Java
// binary the panes run. Loopback traffic (the harness and the panes) is not
// affected by the rule.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFileFn } from "./dynamodb-local.js";

export const SOCKETFILTERFW = "/usr/libexec/ApplicationFirewall/socketfilterfw";

/** `--getglobalstate` output: "Firewall is enabled. (State = 1)". State 2 is
 *  "block all", which is on too. Anything unrecognised counts as off. */
export function parseGlobalState(out: string): boolean {
  const state = /State\s*=\s*(\d+)/.exec(out);
  if (state) return Number(state[1]) >= 1;
  return /firewall is enabled/i.test(out);
}

/** `--getappblocked <path>` output: "Incoming connection to <path> is
 *  blocked", "… is permitted", or "The application is not part of the
 *  firewall". Only the first counts. */
export function parseAppBlocked(out: string): boolean {
  return /\bis blocked\s*$/im.test(out);
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The commands that make the check pass, to print for the reviewer. */
export function firewallFixCommands(javaBinary: string, { enabled }: { enabled: boolean }): string[] {
  const java = shellQuote(javaBinary);
  return [
    ...(enabled ? [] : [`sudo ${SOCKETFILTERFW} --setglobalstate on`]),
    `sudo ${SOCKETFILTERFW} --add ${java}`,
    `sudo ${SOCKETFILTERFW} --blockapp ${java}`,
  ];
}

/** Throws unless inbound connections to `javaBinary` are blocked. On macOS
 *  the application firewall must be on and must block that binary; the error
 *  carries the commands to run. Elsewhere there's no check, so it throws
 *  unless the reviewer explicitly takes responsibility with
 *  QA_ALLOW_UNFIREWALLED=1 (`allowUnfirewalled`). */
export async function assertJavaInboundBlocked(javaBinary: string, {
  platform = process.platform,
  allowUnfirewalled = false,
  execFileFn = promisify(execFile) as ExecFileFn,
}: {
  platform?: NodeJS.Platform;
  allowUnfirewalled?: boolean;
  execFileFn?: ExecFileFn;
} = {}): Promise<void> {
  if (platform !== "darwin") {
    if (allowUnfirewalled) return;
    throw new Error("unsupported platform: bind a host firewall rule for DynamoDB Local and set QA_ALLOW_UNFIREWALLED=1");
  }
  const enabled = parseGlobalState((await execFileFn(SOCKETFILTERFW, ["--getglobalstate"])).stdout);
  const blocked = parseAppBlocked((await execFileFn(SOCKETFILTERFW, ["--getappblocked", javaBinary])).stdout);
  if (enabled && blocked) return;
  throw new Error([
    `DynamoDB Local listens on every interface, and the macOS firewall ${enabled ? "does not block" : "is off, so it cannot block"} ` +
      `inbound connections to ${javaBinary}. Run:`,
    ...firewallFixCommands(javaBinary, { enabled }).map((cmd) => `  ${cmd}`),
    "then start pnpm qa again.",
  ].join("\n"));
}
