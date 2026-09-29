import type { Pane } from "@critical-labs/qa-conductor";
import { describe, expect, it } from "vitest";
import type { PaneDb } from "./dynamodb-local.js";
import { derivePaneEnv, prodEnvFrom } from "./env.js";

const pane: Pane<PaneDb> = {
  ref: { role: "pr", slug: "qa-7-pr", publicOrigin: "http://127.0.0.1:3102" },
  dsn: "http://127.0.0.1:50123",
  db: { endpoint: "http://127.0.0.1:50123", tableName: "agent-identity-qa", region: "us-east-1" },
  services: { api: { url: "http://127.0.0.1:50124", port: 50124 } },
  publicOrigin: "http://127.0.0.1:3102",
};

const prodEnv = { MAIL_DOMAIN: "mail.example.test", PUBLIC_REPOS: "o/a,o/b", AUTO_CAPABILITIES: "email" };

describe("derivePaneEnv", () => {
  it("gives the api exactly its declared keys", () => {
    expect(derivePaneEnv({ prodEnv, pane })).toEqual({
      api: {
        PORT: "50124",
        TABLE_NAME: "agent-identity-qa",
        AWS_ENDPOINT_URL_DYNAMODB: "http://127.0.0.1:50123",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "local",
        AWS_SECRET_ACCESS_KEY: "local",
        MAIL_DOMAIN: "mail.example.test",
        PUBLIC_REPOS: "o/a,o/b",
        AUTO_CAPABILITIES: "email",
        FLEET_KEY_REQUIRED: "true",
      },
    });
  });

  it("passes nothing else through from the base env", () => {
    const env = derivePaneEnv({
      prodEnv: { ...prodEnv, AWS_SECRET_ACCESS_KEY: "real", AWS_PROFILE: "prod", GITHUB_QA_TOKEN: "t", FLEET_KEY_REQUIRED: "false" },
      pane,
    });
    expect(Object.keys(env)).toEqual(["api"]);
    expect(env.api.AWS_SECRET_ACCESS_KEY).toBe("local");
    expect(env.api.FLEET_KEY_REQUIRED).toBe("true");
    expect(env.api).not.toHaveProperty("AWS_PROFILE");
    expect(env.api).not.toHaveProperty("GITHUB_QA_TOKEN");
  });

  it("keeps the optional lists empty (fail closed) when unset", () => {
    const env = derivePaneEnv({ prodEnv: { MAIL_DOMAIN: "mail.example.test" }, pane });
    expect(env.api.PUBLIC_REPOS).toBe("");
    expect(env.api.AUTO_CAPABILITIES).toBe("");
  });

  it("refuses a pane without a mail domain or a database", () => {
    expect(() => derivePaneEnv({ prodEnv: {}, pane })).toThrow(/MAIL_DOMAIN/);
    expect(() => derivePaneEnv({ prodEnv, pane: { ...pane, dsn: null } })).toThrow(/database/);
  });
});

describe("prodEnvFrom", () => {
  it("maps the QA config onto the keys derivePaneEnv reads", () => {
    expect(prodEnvFrom({ mailDomain: "mail.example.test", publicRepos: "o/a", autoCapabilities: "" })).toEqual({
      MAIL_DOMAIN: "mail.example.test", PUBLIC_REPOS: "o/a", AUTO_CAPABILITIES: "",
    });
  });
});
