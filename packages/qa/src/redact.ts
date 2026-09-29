/** A table item as the DynamoDB document client returns it. */
export type Item = Record<string, unknown>;

/** Credential hashes (fleet, admin and viewer keys) and replay nonces: none
 *  of them belong in a QA pane, which mints its own viewer key. */
const DROPPED_PREFIXES = ["FLEET#", "ADMINKEY#", "VIEWER#", "NONCE#"];

/** The email attributes a pane keeps verbatim. An allowlist, so a sensitive
 *  attribute added to emails later is dropped by default. `subject`, `text`
 *  and `links` are rewritten separately. */
const EMAIL_KEEP = [
  "PK", "SK", "id", "messageId", "from", "receivedAt", "rawS3Key", "auth", "unsolicited", "expiresAt",
];

export const REDACTED_TEXT = "[redacted for QA]";

const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;
const CODE_RE = /\d{4,}/g;

/** Subjects stay readable, but a login code or a magic link in one must not
 *  reach the pane: URLs become [link] and digit runs of 4+ become ••••. URLs
 *  go first, so digits inside a link never survive as a partial match. */
export function maskSubject(subject: string): string {
  return subject.replace(URL_RE, "[link]").replace(CODE_RE, "••••");
}

const isEmail = (item: Item) =>
  String(item.PK ?? "").startsWith("MAILBOX#") && String(item.SK ?? "").startsWith("EMAIL#");

/** What of one prod item may go into a QA pane: the item to write, or null
 *  to drop it. Pure: the input is never modified.
 *  - key hashes and nonces are dropped;
 *  - emails keep their envelope (sender, dates, verdicts, masked subject),
 *    while the body is replaced and the links emptied: a mailbox can hold
 *    live login codes and magic links;
 *  - everything else (agents, address mirrors, activity, status) is copied. */
export function redactItem(item: Item): Item | null {
  const pk = String(item.PK ?? "");
  if (DROPPED_PREFIXES.some((prefix) => pk.startsWith(prefix))) return null;
  if (!isEmail(item)) return { ...item };

  const out: Item = {};
  for (const key of EMAIL_KEEP) if (key in item) out[key] = item[key];
  if (typeof item.subject === "string") out.subject = maskSubject(item.subject);
  // Set even when the body lived in S3 (bodyS3Key is removed), so the pane
  // shows the redaction rather than an empty body.
  out.text = REDACTED_TEXT;
  out.links = [];
  return out;
}
