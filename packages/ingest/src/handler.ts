import type { AgentsRepo, EmailsRepo } from "@agent-identity/api";
import type { SESEventRecord } from "aws-lambda";
import { parseEmail } from "./parse.js";

export interface IngestDeps {
  getRaw: (s3Key: string) => Promise<Buffer>;
  putBodyOverflow: (agentId: string, emailId: string, body: object) => Promise<string>;
  agents: Pick<AgentsRepo, "getByLocalPart">;
  emails: Pick<EmailsRepo, "putEmail">;
  maxInlineBodyBytes: number;
}

export async function processRecord(record: SESEventRecord, deps: IngestDeps): Promise<void> {
  const { mail, receipt } = record.ses;
  if (receipt.spamVerdict.status === "FAIL" || receipt.virusVerdict.status === "FAIL") return;

  const rawS3Key = `raw/${mail.messageId}`;
  let parsed: Awaited<ReturnType<typeof parseEmail>> | undefined;

  for (const recipient of receipt.recipients) {
    const localPart = recipient.split("@")[0];
    const agent = await deps.agents.getByLocalPart(localPart);
    if (!agent || agent.status !== "active") continue;

    parsed ??= await parseEmail(await deps.getRaw(rawS3Key));
    const bodySize = Buffer.byteLength(parsed.text) + Buffer.byteLength(parsed.html ?? "");
    const base = {
      from: parsed.from, subject: parsed.subject,
      receivedAt: mail.timestamp, links: parsed.links, rawS3Key,
    };
    if (bodySize > deps.maxInlineBodyBytes) {
      const bodyS3Key = await deps.putBodyOverflow(agent.agentId, mail.messageId, {
        text: parsed.text, html: parsed.html, links: parsed.links,
      });
      await deps.emails.putEmail(agent.agentId, { ...base, bodyS3Key });
    } else {
      await deps.emails.putEmail(agent.agentId, {
        ...base, text: parsed.text, html: parsed.html,
      });
    }
  }
}

// ---- Lambda wiring ----
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AgentsRepo as AgentsRepoImpl, EmailsRepo as EmailsRepoImpl } from "@agent-identity/api";
import type { SESEvent } from "aws-lambda";

export function makeLambdaDeps(): IngestDeps {
  const table = process.env.TABLE_NAME!;
  const bucket = process.env.BUCKET_NAME!;
  const domain = process.env.MAIL_DOMAIN!;
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = new S3Client({});
  return {
    getRaw: async (key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
    putBodyOverflow: async (agentId, emailId, body) => {
      const key = `bodies/${agentId}/${emailId}.json`;
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: JSON.stringify(body),
        ContentType: "application/json",
      }));
      return key;
    },
    agents: new AgentsRepoImpl(ddb, table, domain),
    emails: new EmailsRepoImpl(ddb, table, Number(process.env.RETENTION_DAYS ?? "90")),
    maxInlineBodyBytes: 300_000,
  };
}

export async function processEvent(event: SESEvent, deps: IngestDeps): Promise<void> {
  for (const record of event.Records) {
    const messageId = record.ses.mail.messageId;
    try {
      await processRecord(record, deps);
    } catch (error) {
      // Do not rethrow: rethrowing triggers an SES whole-event retry that would
      // duplicate already-stored mail. The raw message remains at raw/<messageId>
      // in S3 for manual recovery, so we prefer continuing over retry.
      console.error("ingest: failed to process record", { messageId, error });
    }
  }
}

export async function handler(event: SESEvent): Promise<void> {
  await processEvent(event, makeLambdaDeps());
}
