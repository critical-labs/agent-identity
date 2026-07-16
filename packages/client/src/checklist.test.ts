import { describe, expect, it } from "vitest";
import { deployChecklist, type ChecklistDeps } from "./checklist.js";

const okRun = async () => ({ ok: true, output: '{"Rules": []}' });
const failRun = async () => ({ ok: false, output: "AccessDenied" });

const deps = (over: Partial<ChecklistDeps> = {}): ChecklistDeps => ({
  run: okRun,
  resolveMx: async () => [{ exchange: "inbound-smtp.us-east-1.amazonaws.com" }],
  ...over,
});

describe("deployChecklist", () => {
  it("covers clone, credentials, deploy, ses identity, mx, rule set, fleet key in order", () => {
    expect(deployChecklist().map((s) => s.title)).toEqual([
      "Clone the agent-identity repository",
      "AWS credentials",
      "CDK bootstrap and deploy",
      "SES domain identity and DNS verification records",
      "MX record",
      "Activate the SES receipt rule set",
      "Mint a fleet key",
    ]);
  });

  it("steps without verification are informational", () => {
    const steps = deployChecklist();
    expect(steps[0].verify).toBeUndefined(); // clone
    expect(steps[6].verify).toBeUndefined(); // fleet key (prompted afterwards)
  });

  it("verifies AWS credentials via sts get-caller-identity", async () => {
    let cmd: string[] = [];
    const d = deps({ run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: "{}" }; } });
    expect(await deployChecklist()[1].verify!(d, { domain: "mail.example.com" })).toBeUndefined();
    expect(cmd).toEqual(["aws", "sts", "get-caller-identity"]);
    expect(await deployChecklist()[1].verify!(deps({ run: failRun }), { domain: "d" }))
      .toMatch(/AccessDenied/);
  });

  it("verifies the stack via describe-stacks AgentIdentity", async () => {
    let cmd: string[] = [];
    const d = deps({ run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: "{}" }; } });
    expect(await deployChecklist()[2].verify!(d, { domain: "mail.example.com" })).toBeUndefined();
    expect(cmd).toEqual(["aws", "cloudformation", "describe-stacks", "--stack-name", "AgentIdentity"]);
  });

  it("verifies the SES identity for the domain", async () => {
    let cmd: string[] = [];
    const d = deps({ run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: "{}" }; } });
    expect(await deployChecklist()[3].verify!(d, { domain: "mail.example.com" })).toBeUndefined();
    expect(cmd).toEqual(["aws", "sesv2", "get-email-identity", "--email-identity", "mail.example.com"]);
  });

  it("verifies MX resolution and reports lookup failures", async () => {
    expect(await deployChecklist()[4].verify!(deps(), { domain: "mail.example.com" })).toBeUndefined();
    const noMx = deps({ resolveMx: async () => [] });
    expect(await deployChecklist()[4].verify!(noMx, { domain: "d" })).toMatch(/no MX record/);
    const dnsErr = deps({ resolveMx: async () => { throw new Error("ENODATA"); } });
    expect(await deployChecklist()[4].verify!(dnsErr, { domain: "d" })).toMatch(/ENODATA/);
  });

  it("verifies an active receipt rule set exists", async () => {
    expect(await deployChecklist()[5].verify!(deps(), { domain: "d" })).toBeUndefined();
    const empty = deps({ run: async () => ({ ok: true, output: "" }) });
    expect(await deployChecklist()[5].verify!(empty, { domain: "d" })).toMatch(/no active receipt rule set/);
  });
});
