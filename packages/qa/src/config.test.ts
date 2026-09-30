import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowUnfirewalled, isMailDomain, loadQaConfig, qaCacheDir, qaEnvFile } from "./config.js";

function envFile(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "qa-config-")), ".env.qa");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const minimal = ["GITHUB_QA_TOKEN=test-token"];

describe("loadQaConfig", () => {
  it("fills in this repo, loopback pane origins and the app defaults", () => {
    const cfg = loadQaConfig(envFile(minimal));
    expect(cfg.repo).toBe("critical-labs/agent-identity");
    expect(cfg.githubToken).toBe("test-token");
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.ports).toEqual({ harness: 3100, base: 3101, pr: 3102 });
    expect(cfg.paneOrigins).toEqual({ base: "http://127.0.0.1:3101", pr: "http://127.0.0.1:3102" });
    expect(cfg.app).toStrictEqual({
      publicRepos: "",
      autoCapabilities: "",
      trustedLogins: ["critical-agent-zero"],
      baseRef: "main",
      stackName: "AgentIdentity",
    });
  });

  it("reads the app keys from the file", () => {
    const cfg = loadQaConfig(envFile([
      ...minimal,
      "# a comment",
      "QA_MAIL_DOMAIN=mail.example.test",
      "QA_REPO=someone/agent-identity",
      "QA_PUBLIC_REPOS=o/a,o/b",
      "QA_AUTO_CAPABILITIES=email",
      "QA_TRUSTED_LOGINS= alice , Bob ,,",
      "QA_BASE_REF=release",
      "QA_STACK_NAME=AgentIdentityStaging",
      "QA_AWS_REGION=eu-west-1",
    ]));
    expect(cfg.repo).toBe("someone/agent-identity");
    expect(cfg.app).toStrictEqual({
      mailDomain: "mail.example.test",
      publicRepos: "o/a,o/b",
      autoCapabilities: "email",
      trustedLogins: ["alice", "Bob"],
      baseRef: "release",
      stackName: "AgentIdentityStaging",
      awsRegion: "eu-west-1",
    });
  });

  it("leaves the AWS region to the default chain unless QA_AWS_REGION is set", () => {
    expect(loadQaConfig(envFile(minimal)).app.awsRegion).toBeUndefined();
    expect(loadQaConfig(envFile([...minimal, "QA_AWS_REGION="])).app.awsRegion).toBeUndefined();
    expect(loadQaConfig(envFile([...minimal, "QA_AWS_REGION=us-west-2"])).app.awsRegion).toBe("us-west-2");
    expect(loadQaConfig(envFile([...minimal, "QA_AWS_REGION=us-gov-west-1"])).app.awsRegion).toBe("us-gov-west-1");
  });

  it("refuses a QA_AWS_REGION that isn't a region, such as one carrying an inline comment", () => {
    // The env file parser keeps an inline comment as part of the value.
    for (const line of [
      "QA_AWS_REGION=us-east-1             # the production stack's region",
      "QA_AWS_REGION=US-EAST-1",
      "QA_AWS_REGION=us-east",
      "QA_AWS_REGION=https://dynamodb.us-east-1.amazonaws.com",
    ]) {
      expect(() => loadQaConfig(envFile([...minimal, line]))).toThrow(/QA_AWS_REGION must be an AWS region like us-east-1/);
    }
  });

  it("lets an explicitly empty QA_TRUSTED_LOGINS trust write access alone", () => {
    expect(loadQaConfig(envFile([...minimal, "QA_TRUSTED_LOGINS="])).app.trustedLogins).toEqual([]);
  });

  it("requires the GitHub token", () => {
    expect(() => loadQaConfig(envFile(["QA_MAIL_DOMAIN=mail.example.test"]))).toThrow(/GITHUB_QA_TOKEN missing/);
  });

  it("leaves the mail domain to the snapshot unless QA_MAIL_DOMAIN overrides it", () => {
    expect(loadQaConfig(envFile(minimal)).app).not.toHaveProperty("mailDomain");
    expect(loadQaConfig(envFile([...minimal, "QA_MAIL_DOMAIN="])).app).not.toHaveProperty("mailDomain");
    expect(loadQaConfig(envFile([...minimal, "QA_MAIL_DOMAIN=agents.example.test"])).app.mailDomain).toBe("agents.example.test");
  });

  it("lower-cases a QA_MAIL_DOMAIN in mixed case, as the agents' addresses are", () => {
    // Such as a value copied from prod's secret, which an older .env.qa may still hold.
    expect(loadQaConfig(envFile([...minimal, "QA_MAIL_DOMAIN=Mail.Example.Test"])).app.mailDomain).toBe("mail.example.test");
    expect(loadQaConfig(envFile([...minimal, "QA_MAIL_DOMAIN=MAIL.EXAMPLE.TEST"])).app.mailDomain).toBe("mail.example.test");
  });

  it("refuses a QA_MAIL_DOMAIN that isn't a bare domain, without echoing it", () => {
    for (const value of [
      // The env file parser keeps an inline comment as part of the value.
      "mail.example.test             # the fleet's domain",
      "https://mail.example.test",
      "mail.example.test:25",
      "mail.example.test/inbox",
      "ops@mail.example.test",
      "mailhost",
      // Only ASCII is lower-cased: the Kelvin sign doesn't become "k", nor a
      // Cyrillic "Е" an "e".
      "K.example.test",
      "mail.Еxample.test",
    ]) {
      let message = "";
      try {
        loadQaConfig(envFile([...minimal, `QA_MAIL_DOMAIN=${value}`]));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/QA_MAIL_DOMAIN must be a bare domain name/);
      // Logs may be pasted publicly: the value, or the domain in it, is never shown.
      expect(message).not.toContain(value);
      expect(message).not.toMatch(/example|mailhost/i);
    }
  });
});

describe("isMailDomain", () => {
  it.each([
    "mail.example.test",
    "example.test",
    "a.b",
    "agents-1.mail.example.test",
    "x1.example.test",
    `${"a".repeat(63)}.example.test`,
  ])("accepts %s", (domain) => {
    expect(isMailDomain(domain)).toBe(true);
  });

  it.each([
    "",
    "localhost",
    "MAIL.example.test",
    "mail.Example.test",
    "https://mail.example.test",
    "mail.example.test:25",
    "mail.example.test/",
    "mail.example.test/inbox",
    "ops@mail.example.test",
    "@mail.example.test",
    "mail..example.test",
    ".mail.example.test",
    "mail.example.test.",
    "-mail.example.test",
    "mail-.example.test",
    "mail_box.example.test",
    "mail example.test",
    " mail.example.test",
    "mail.example.test\n",
    // Look-alikes: a Cyrillic "е", and the Kelvin sign, which lower-cases to "k".
    "mail.examplе.test",
    "K.example.test",
    `${"a".repeat(64)}.example.test`,
    `${"a.".repeat(127)}test`,
  ])("refuses %j", (value) => {
    expect(isMailDomain(value)).toBe(false);
  });
});

describe("qaEnvFile", () => {
  it("defaults to .env.qa at the repo root", () => {
    const path = qaEnvFile({});
    expect(path.endsWith(".env.qa")).toBe(true);
    expect(existsSync(join(dirname(path), "pnpm-workspace.yaml"))).toBe(true);
  });

  it("honours QA_ENV_FILE", () => {
    expect(qaEnvFile({ QA_ENV_FILE: "/elsewhere/qa.env" })).toBe("/elsewhere/qa.env");
  });
});

describe("qaCacheDir", () => {
  it("lives under the XDG cache, else ~/.cache", () => {
    expect(qaCacheDir({ XDG_CACHE_HOME: "/xdg", HOME: "/home/r" })).toBe("/xdg/qa-conductor/agent-identity");
    expect(qaCacheDir({ HOME: "/home/r" })).toBe("/home/r/.cache/qa-conductor/agent-identity");
  });

  it("ignores a relative XDG_CACHE_HOME, as the XDG base-directory spec requires", () => {
    expect(qaCacheDir({ XDG_CACHE_HOME: "rel", HOME: "/home/r" })).toBe("/home/r/.cache/qa-conductor/agent-identity");
  });
});

describe("allowUnfirewalled", () => {
  it("is on only for an explicit 1, from the file or the environment", () => {
    expect(allowUnfirewalled({}, {})).toBe(false);
    expect(allowUnfirewalled({ QA_ALLOW_UNFIREWALLED: "true" })).toBe(false);
    expect(allowUnfirewalled({}, { QA_ALLOW_UNFIREWALLED: "1" })).toBe(true);
    expect(allowUnfirewalled({ QA_ALLOW_UNFIREWALLED: "1" })).toBe(true);
  });
});
