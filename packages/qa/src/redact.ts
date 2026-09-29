/** A table item as the DynamoDB document client returns it. */
export type Item = Record<string, unknown>;

/** The item shapes a QA pane may hold. It fails closed: anything else is
 *  dropped, including the credential hashes (FLEET#, ADMINKEY#, VIEWER#),
 *  replay nonces (NONCE#) and any record type added later. A new type goes
 *  in only by adding it here, deliberately. */
export type Shape = "agent" | "addr" | "activity" | "status" | "email";

/** (PK prefix, SK) → shape, matching every writer in the repo
 *  (packages/api/src/db/*, packages/admin/src/commands.ts). An `sk` ending
 *  in `#` is a prefix; any other is the exact sort key. */
const SHAPES: { pk: string; sk: string; shape: Shape }[] = [
  { pk: "AGENT#", sk: "AGENT", shape: "agent" },
  { pk: "ADDR#", sk: "ADDR", shape: "addr" },
  { pk: "AGENT#", sk: "ACT#", shape: "activity" },
  { pk: "AGENT#", sk: "STATUS", shape: "status" },
  { pk: "MAILBOX#", sk: "EMAIL#", shape: "email" },
];

export function shapeOf(item: Item): Shape | null {
  const { PK, SK } = item;
  if (typeof PK !== "string" || typeof SK !== "string") return null;
  const match = SHAPES.find(({ pk, sk }) =>
    PK.startsWith(pk) && (sk.endsWith("#") ? SK.startsWith(sk) : SK === sk));
  return match?.shape ?? null;
}

/** A type tag, as this table's keys use them (AGENT, SIG, FLEET…). */
const TAG = /^[A-Z][A-Z_]{0,31}$/;

/** One key's part for the drop report: the text up to and including its
 *  first `#`, or the whole key when it has none. A part that isn't a type
 *  tag could be a value, so it is reported as `?`. */
function keyPart(key: unknown): string {
  if (typeof key !== "string") return "?";
  const hash = key.indexOf("#");
  const tag = hash === -1 ? key : key.slice(0, hash);
  if (!TAG.test(tag)) return "?";
  return hash === -1 ? tag : `${tag}#`;
}

/** What the snapshot's drop report counts an item under, e.g. `NONCE#/SIG#`
 *  or `MAILBOX#/META`. Never a value. */
export function shapeKey(item: Item): string {
  return `${keyPart(item.PK)}/${keyPart(item.SK)}`;
}

/** The email attributes a pane keeps verbatim. An allowlist, so a sensitive
 *  attribute added to emails later is dropped by default. `subject`, `text`
 *  and `links` are rewritten separately. */
const EMAIL_KEEP = [
  "PK", "SK", "id", "messageId", "from", "receivedAt", "rawS3Key", "auth", "unsolicited", "expiresAt",
];

export const REDACTED_TEXT = "[redacted for QA]";
export const MASK = "••••";

/** Any Unicode number: decimal digits (\p{Nd}, full-width ones included)
 *  and the rest of \p{N} (superscript, circled…). */
const NUMBER = /\p{N}/u;
/** A host, path, address or link: `/`, `@`, or a `.` followed by a letter. */
const HOST_OR_PATH = /[/@]|\.\p{L}/u;
const LINK = /https?:\/\/|www\./iu;

/** A token a login code or a magic link could hide in. It is checked as
 *  written and in its NFKC form, so full-width `／`, `＠` and `．` count too. */
function isSensitiveToken(token: string): boolean {
  return [token, token.normalize("NFKC")].some((t) => NUMBER.test(t) || HOST_OR_PATH.test(t) || LINK.test(t));
}

/** Subjects stay readable, but a login code or a magic link in one must not
 *  reach the pane. Every whitespace-separated token with a digit, or that
 *  looks like a host, path or link, becomes ••••; plain words and the
 *  spacing stay. It loses some fidelity (`PR #12` → `PR ••••`), on purpose:
 *  codes come in too many formats (123 456, X4K-9PQ, １２３…) to pick out. */
export function maskSubject(subject: string): string {
  // With a capture group, split keeps the whitespace at the odd indexes.
  return subject
    .split(/(\s+)/u)
    .map((part, i) => (i % 2 === 0 && part && isSensitiveToken(part) ? MASK : part))
    .join("");
}

/** What of one prod item may go into a QA pane: the item to write, or null
 *  to drop it. Pure: the input is never modified.
 *  - agents, address mirrors, activity and status are copied;
 *  - emails keep their envelope (sender, dates, verdicts, masked subject),
 *    while the body is replaced and the links emptied: a mailbox can hold
 *    live login codes and magic links;
 *  - every other shape is dropped (see SHAPES). */
export function redactItem(item: Item): Item | null {
  const shape = shapeOf(item);
  if (shape === null) return null;
  if (shape !== "email") return { ...item };

  const out: Item = {};
  for (const key of EMAIL_KEEP) if (key in item) out[key] = item[key];
  if (typeof item.subject === "string") out.subject = maskSubject(item.subject);
  // Set even when the body lived in S3 (bodyS3Key is removed), so the pane
  // shows the redaction rather than an empty body.
  out.text = REDACTED_TEXT;
  out.links = [];
  return out;
}
