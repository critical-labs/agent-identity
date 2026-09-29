import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowUnfirewalled, loadQaConfig, qaCacheDir, qaEnvFile } from "./config.js";

function envFile(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "qa-config-")), ".env.qa");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const minimal = ["GITHUB_QA_TOKEN=test-token", "QA_MAIL_DOMAIN=mail.example.test"];

describe("loadQaConfig", () => {
  it("fills in this repo, loopback pane origins and the app defaults", () => {
    const cfg = loadQaConfig(envFile(minimal));
    expect(cfg.repo).toBe("critical-labs/agent-identity");
    expect(cfg.githubToken).toBe("test-token");
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.ports).toEqual({ harness: 3100, base: 3101, pr: 3102 });
    expect(cfg.paneOrigins).toEqual({ base: "http://127.0.0.1:3101", pr: "http://127.0.0.1:3102" });
    expect(cfg.app).toEqual({
      mailDomain: "mail.example.test",
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
      "QA_REPO=someone/agent-identity",
      "QA_PUBLIC_REPOS=o/a,o/b",
      "QA_AUTO_CAPABILITIES=email",
      "QA_TRUSTED_LOGINS= alice , Bob ,,",
      "QA_BASE_REF=release",
      "QA_STACK_NAME=AgentIdentityStaging",
    ]));
    expect(cfg.repo).toBe("someone/agent-identity");
    expect(cfg.app).toEqual({
      mailDomain: "mail.example.test",
      publicRepos: "o/a,o/b",
      autoCapabilities: "email",
      trustedLogins: ["alice", "Bob"],
      baseRef: "release",
      stackName: "AgentIdentityStaging",
    });
  });

  it("lets an explicitly empty QA_TRUSTED_LOGINS trust write access alone", () => {
    expect(loadQaConfig(envFile([...minimal, "QA_TRUSTED_LOGINS="])).app.trustedLogins).toEqual([]);
  });

  it("requires the mail domain and the GitHub token", () => {
    expect(() => loadQaConfig(envFile(["GITHUB_QA_TOKEN=test-token"]))).toThrow(/QA_MAIL_DOMAIN missing/);
    expect(() => loadQaConfig(envFile(["QA_MAIL_DOMAIN=mail.example.test"]))).toThrow(/GITHUB_QA_TOKEN missing/);
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
