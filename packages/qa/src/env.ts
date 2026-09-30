import type { Pane, PaneEnv } from "@critical-labs/qa-conductor";
import { LOCAL_CREDENTIALS, QA_REGION, QA_TABLE, type PaneDb } from "./dynamodb-local.js";

/** The deployment settings a pane copies from prod: the lists from the QA
 *  config, and the mail domain readBaseEnv resolved (QA_MAIL_DOMAIN, else
 *  the snapshot's). */
export function prodEnvFrom(app: { mailDomain: string; publicRepos: string; autoCapabilities: string }): Record<string, string> {
  return { MAIL_DOMAIN: app.mailDomain, PUBLIC_REPOS: app.publicRepos, AUTO_CAPABILITIES: app.autoCapabilities };
}

/** The whole environment of a pane's dev server. qa-conductor's process
 *  provisioner passes only PATH plus this map, so nothing of the harness's
 *  own environment (its AWS credentials, its GitHub token) reaches PR code.
 *  The pane talks to its own emulator with the dummy credentials, and the
 *  fleet key stays required, as in prod. */
export function derivePaneEnv({ prodEnv, pane }: { prodEnv: Record<string, string>; pane: Pane<PaneDb> }): PaneEnv {
  if (!prodEnv.MAIL_DOMAIN) throw new Error("MAIL_DOMAIN missing from the base env: set QA_MAIL_DOMAIN in .env.qa");
  if (!pane.dsn) throw new Error(`pane ${pane.ref.role} has no database endpoint`);
  return {
    api: {
      PORT: String(pane.services.api.port),
      TABLE_NAME: QA_TABLE,
      AWS_ENDPOINT_URL_DYNAMODB: pane.dsn,
      AWS_REGION: QA_REGION,
      AWS_ACCESS_KEY_ID: LOCAL_CREDENTIALS.accessKeyId,
      AWS_SECRET_ACCESS_KEY: LOCAL_CREDENTIALS.secretAccessKey,
      MAIL_DOMAIN: prodEnv.MAIL_DOMAIN,
      PUBLIC_REPOS: prodEnv.PUBLIC_REPOS ?? "",
      AUTO_CAPABILITIES: prodEnv.AUTO_CAPABILITIES ?? "",
      FLEET_KEY_REQUIRED: "true",
    },
  };
}
