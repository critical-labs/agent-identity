import { deterministicUlid, encodeTime, type EmailFull, type EmailSummary } from "@agent-identity/shared";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
} from "@aws-sdk/lib-dynamodb";

export interface NewEmail {
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string;
  text?: string;
  html?: string;
  links: string[];
  rawS3Key: string;
  bodyS3Key?: string;
}

export class InvalidCursorError extends Error {}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    throw new InvalidCursorError("malformed cursor");
  }
}

export class EmailsRepo {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly retentionDays: number,
  ) {}

  async putEmail(agentId: string, email: NewEmail): Promise<string> {
    const id = deterministicUlid(Date.parse(email.receivedAt), email.messageId);
    const expiresAt =
      Math.floor(Date.parse(email.receivedAt) / 1000) + this.retentionDays * 24 * 3600;
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: { PK: `MAILBOX#${agentId}`, SK: `EMAIL#${id}`, expiresAt, ...email },
    }));
    return id;
  }

  async listEmails(
    agentId: string,
    opts: { since?: string; limit?: number; cursor?: string },
  ): Promise<{ emails: EmailSummary[]; cursor?: string }> {
    const cond = opts.since ? "PK = :pk AND SK >= :sk" : "PK = :pk AND begins_with(SK, :pfx)";
    const values: Record<string, string> = { ":pk": `MAILBOX#${agentId}` };
    if (opts.since) values[":sk"] = `EMAIL#${encodeTime(Date.parse(opts.since))}`;
    else values[":pfx"] = "EMAIL#";
    const res = await this.ddb.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: cond,
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
      Limit: opts.limit ?? 25,
      ExclusiveStartKey: opts.cursor ? decodeCursor(opts.cursor) : undefined,
    }));
    return {
      emails: (res.Items ?? []).map((i) => ({
        id: (i.SK as string).slice("EMAIL#".length),
        from: i.from as string,
        subject: i.subject as string,
        receivedAt: i.receivedAt as string,
      })),
      cursor: res.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64url")
        : undefined,
    };
  }

  async getEmail(agentId: string, id: string): Promise<(EmailFull & { bodyS3Key?: string }) | undefined> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `MAILBOX#${agentId}`, SK: `EMAIL#${id}` },
    }));
    if (!Item) return undefined;
    return {
      id,
      from: Item.from as string,
      subject: Item.subject as string,
      receivedAt: Item.receivedAt as string,
      text: (Item.text as string) ?? "",
      html: Item.html as string | undefined,
      links: (Item.links as string[]) ?? [],
      bodyS3Key: Item.bodyS3Key as string | undefined,
    };
  }
}
