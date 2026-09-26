import { parseRepoAllowlist } from "@agent-identity/shared";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Deps } from "./app.js";
import { ActivityRepo } from "./db/activity.js";
import { AgentsRepo } from "./db/agents.js";
import { EmailsRepo } from "./db/emails.js";
import { NoncesRepo } from "./db/nonces.js";

type Env = Record<string, string | undefined>;

const required = (env: Env, key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

/** The one env → Deps mapping, shared by the Lambda entry and the local dev
 *  server so the two cannot drift. Clients and the body reader are injected:
 *  only the Lambda reads overflow bodies from S3. */
export function buildDeps({ env, ddb, readBody }: {
  env: Env;
  ddb: DynamoDBDocumentClient;
  readBody: Deps["readBody"];
}): Deps {
  const table = required(env, "TABLE_NAME");
  const domain = required(env, "MAIL_DOMAIN");
  const retentionDays = Number(env.RETENTION_DAYS ?? "90");

  return {
    agents: new AgentsRepo(ddb, table, domain),
    emails: new EmailsRepo(ddb, table, retentionDays),
    activity: new ActivityRepo(ddb, table, retentionDays),
    nonces: new NoncesRepo(ddb, table),
    readBody,
    fleetKeyRequired: env.FLEET_KEY_REQUIRED !== "false",
    // The fleet mail routes redact ANY address at this domain: the viewer
    // knows every agentId, so the domain alone reconstructs every mailbox.
    mailDomain: domain,
    // Unset or empty PUBLIC_REPOS parses to the empty allowlist: the public
    // fleet tier then shows no forge events at all — fail closed.
    publicRepos: parseRepoAllowlist(env.PUBLIC_REPOS ?? ""),
    // Operator deployment policy: capability slugs /register may grant at
    // identity birth. Unset or empty = feature off (fail closed).
    autoCapabilities: (env.AUTO_CAPABILITIES ?? "")
      .split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  };
}
