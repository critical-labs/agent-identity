import type { ActivityEvent, AgentRecord, AgentStatus, NewEmail } from "@agent-identity/api";

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

/** A type tag before a `#`, as this table's keys use them (AGENT#, SIG#…). */
const TAG = /^[A-Z][A-Z_]{0,31}$/;

/** The whole keys (no `#`) the repo writes. An upper-case key can't be told
 *  apart from an upper-case value (a letter-only code), so a key without a
 *  `#` is reported only when it is one of these. Add a tag here on purpose. */
const KNOWN_TAGS = new Set(["AGENT", "ADDR", "STATUS", "FLEET", "ADMINKEY", "VIEWER"]);

/** One key's part for the drop report: the type tag up to and including its
 *  first `#`, or the whole key when it has none and is a known tag. Anything
 *  else could be a value, so it is reported as `?`. */
function keyPart(key: unknown): string {
  if (typeof key !== "string") return "?";
  const hash = key.indexOf("#");
  if (hash === -1) return KNOWN_TAGS.has(key) ? key : "?";
  const tag = key.slice(0, hash);
  return TAG.test(tag) ? `${tag}#` : "?";
}

/** What the snapshot's drop report counts an item under, e.g. `NONCE#/SIG#`
 *  or `FLEET#/FLEET`. Never a value. */
export function shapeKey(item: Item): string {
  return `${keyPart(item.PK)}/${keyPart(item.SK)}`;
}

/** Attribute names of the record type T, checked by the compiler, so a
 *  renamed field breaks the build here instead of silently dropping out. */
const fieldsOf = <T>() => <K extends keyof T & string>(...names: K[]): string[] => names;

/** The attributes each shape keeps verbatim. Allowlists, like the shapes: a
 *  field added to a record later (a webhook secret, a key hash, a session
 *  token) is dropped by default, and the drop report names it (see
 *  unlistedAttributes) so it can be added here on purpose. */
const KEEP: Record<Shape, readonly string[]> = {
  agent: ["PK", "SK", ...fieldsOf<AgentRecord>()(
    "agentId", "address", "publicKey", "status", "createdAt", "capabilities", "mailbox", "allowlist", "catchAll",
  )],
  addr: ["PK", "SK", "fingerprint"],
  // `expiresAt` is the claimed events' TTL, added by ActivityRepo.putEvent.
  activity: ["PK", "SK", "expiresAt", ...fieldsOf<ActivityEvent>()(
    "agentId", "ts", "class", "type", "summary", "detail", "ref",
  )],
  status: ["PK", "SK", ...fieldsOf<AgentStatus>()("state", "label", "updatedAt")],
  // `subject`, `text` and `links` are rewritten separately (see EMAIL_HANDLED).
  email: ["PK", "SK", "id", "expiresAt", ...fieldsOf<NewEmail>()(
    "messageId", "from", "receivedAt", "rawS3Key", "auth", "unsolicited",
  )],
};

/** Email attributes redactItem rewrites (`subject`, `text`, `links`) or
 *  removes on purpose (`html`, `bodyS3Key`): known, so not reported. */
const EMAIL_HANDLED: readonly string[] = fieldsOf<NewEmail>()("subject", "text", "links", "html", "bodyS3Key");

/** An attribute name as the drop report may print it: a camelCase
 *  identifier, like every attribute the repo writes. Anything else is `?`. */
const ATTRIBUTE_NAME = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** The attributes of an item of a listed shape that redactItem drops without
 *  knowing them: neither kept nor, for emails, handled on purpose. Names
 *  only (`?` for a name that isn't an identifier), sorted; never values.
 *  Empty for an item of an unlisted shape, which is dropped whole. */
export function unlistedAttributes(item: Item): string[] {
  const shape = shapeOf(item);
  if (shape === null) return [];
  const known = new Set([...KEEP[shape], ...(shape === "email" ? EMAIL_HANDLED : [])]);
  return Object.keys(item)
    .filter((name) => !known.has(name))
    .map((name) => (ATTRIBUTE_NAME.test(name) ? name : "?"))
    .sort();
}

export const REDACTED_TEXT = "[redacted for QA]";
export const MASK = "••••";

/** A plain word: lower-case letters, optionally after one capital and with
 *  one inner apostrophe (`Welcome`, `don't`), in optional quotes or brackets
 *  and with optional trailing punctuation (`world.`, `(optional)`). */
const PLAIN_WORD = /^[("'“‘]*\p{Lu}?\p{Ll}+(?:['’]\p{Ll}+)?[)"'”’.,:;!?]*$/u;
/** A capital letter on its own (`I`, `A`). */
const SINGLE_CAPITAL = /^\p{Lu}$/u;
/** No letter and no number at all (`—`, `&`, `-`). */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u;

/** A token a pane may show. An allowlist: a login code can't be told apart
 *  from other text (123 456, X4K-9PQ, QWERTY, dog-cat-fish, １２３…), so
 *  anything that isn't plainly a word is masked. It's checked in its NFKC
 *  form, so full-width and other compatibility forms count as what they
 *  stand for (`１２３` is a number, `ｃｏｄｅ` a word). */
function isPlainToken(token: string): boolean {
  const t = token.normalize("NFKC");
  return PLAIN_WORD.test(t) || SINGLE_CAPITAL.test(t) || PUNCTUATION_ONLY.test(t);
}

/** Subjects stay readable, but a login code or a magic link in one must not
 *  reach the pane. Every whitespace-separated token that isn't a plain word
 *  (see isPlainToken) becomes ••••; plain words and the spacing stay. It
 *  loses fidelity on purpose: numbers, acronyms and mixed case go too
 *  (`PR #12 merged` → `•••• •••• merged`, `[GitHub]` → `••••`).
 *
 *  Known gap: a code that is a single lower-case or capitalised word
 *  (`kxqprt`) passes, since it can't be told from a word without a
 *  dictionary. */
export function maskSubject(subject: string): string {
  // With a capture group, split keeps the whitespace at the odd indexes.
  return subject
    .split(/(\s+)/u)
    .map((part, i) => (i % 2 === 0 && part && !isPlainToken(part) ? MASK : part))
    .join("");
}

/** What of one prod item may go into a QA pane: the item to write, or null
 *  to drop it. Pure: the input is never modified.
 *  - agents, address mirrors, activity and status keep their listed
 *    attributes (see KEEP);
 *  - emails keep their envelope (sender, dates, verdicts, masked subject),
 *    while the body is replaced and the links emptied: a mailbox can hold
 *    live login codes and magic links;
 *  - every other shape is dropped (see SHAPES), and so is every attribute a
 *    shape doesn't list. */
export function redactItem(item: Item): Item | null {
  const shape = shapeOf(item);
  if (shape === null) return null;

  const out: Item = {};
  for (const key of KEEP[shape]) if (Object.hasOwn(item, key)) out[key] = item[key];
  if (shape !== "email") return out;

  if (typeof item.subject === "string") out.subject = maskSubject(item.subject);
  // Set even when the body lived in S3 (bodyS3Key is removed), so the pane
  // shows the redaction rather than an empty body.
  out.text = REDACTED_TEXT;
  out.links = [];
  return out;
}
