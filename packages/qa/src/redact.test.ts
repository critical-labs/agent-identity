import { describe, expect, it } from "vitest";
import { MASK, REDACTED_TEXT, maskSubject, redactItem, shapeKey, shapeOf } from "./redact.js";

const email = (extra: Record<string, unknown> = {}) => ({
  PK: "MAILBOX#482913",
  SK: "EMAIL#01J9ZQ4Y7N8M2K5T3V6W0X1Y2Z",
  messageId: "<abc@mail.example.test>",
  from: "noreply@example.test",
  subject: "Welcome aboard",
  receivedAt: "2026-09-01T12:00:00.000Z",
  rawS3Key: "raw/abc",
  auth: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
  expiresAt: 1788000000,
  text: "hello",
  html: "<p>hello</p>",
  links: ["https://example.test/a"],
  ...extra,
});

describe("redactItem: item shapes are an allowlist", () => {
  it.each([
    ["agent", { PK: "AGENT#fp1", SK: "AGENT", agentId: "482913", address: "482913@mail.example.test", status: "active" }],
    ["addr", { PK: "ADDR#482913", SK: "ADDR", fingerprint: "fp1" }],
    ["activity", { PK: "AGENT#482913", SK: "ACT#2026-09-01T12:00:00.000Z#01J9", kind: "pr", repo: "o/r", title: "Fix 12345" }],
    ["status", { PK: "AGENT#482913", SK: "STATUS", state: "working" }],
  ])("copies an %s item unchanged", (shape, item) => {
    expect(shapeOf(item)).toBe(shape);
    const out = redactItem(item);
    expect(out).toEqual(item);
    expect(out).not.toBe(item);
  });

  it("recognises an email", () => {
    expect(shapeOf(email())).toBe("email");
  });

  it.each([
    // Credential hashes and replay nonces, as the repo writes them.
    ["FLEET#9f86d081884c7d65", "FLEET"],
    ["ADMINKEY#9f86d081884c7d65", "ADMINKEY"],
    ["VIEWER#9f86d081884c7d65", "VIEWER"],
    ["NONCE#fp1", "SIG#c2lnbmF0dXJl"],
    // Shapes no writer produces today: a future record type is dropped by default.
    ["MAILBOX#482913", "META"],
    ["OTP#482913", "OTP"],
    ["AGENT#fp1", "SESSION#1"],
    ["AGENT#fp1", "AGENTS"],
    ["AGENT#fp1", "STATUS#1"],
    ["AGENT#fp1", "EMAIL#01J9"],
    ["ADDR#482913", "ADDRESS"],
    ["ADDR#482913", "ACT#01J9"],
    ["MAILBOX#482913", "ACT#01J9"],
    ["agent#fp1", "AGENT"],
    ["AGENT", "AGENT"],
  ])("drops %s / %s", (PK, SK) => {
    const item = { PK, SK, secret: "s3cr3t" };
    expect(shapeOf(item)).toBeNull();
    expect(redactItem(item)).toBeNull();
  });

  it("drops items whose keys are missing or not strings", () => {
    for (const item of [{}, { PK: "AGENT#fp1" }, { SK: "AGENT" }, { PK: ["AGENT#fp1"], SK: "AGENT" }, { PK: "AGENT#fp1", SK: 1 }]) {
      expect(redactItem(item)).toBeNull();
    }
  });
});

describe("shapeKey: what the drop report counts by, never a value", () => {
  it.each([
    [{ PK: "FLEET#9f86d081884c7d65", SK: "FLEET" }, "FLEET#/FLEET"],
    [{ PK: "NONCE#fp1", SK: "SIG#c2lnbmF0dXJl" }, "NONCE#/SIG#"],
    [{ PK: "AGENT#fp1", SK: "SESSION#1" }, "AGENT#/SESSION#"],
    [{ PK: "MAILBOX#482913", SK: "META" }, "MAILBOX#/META"],
    [{ PK: "OTP#482913", SK: "OTP" }, "OTP#/OTP"],
  ])("%o → %s", (item, key) => {
    expect(shapeKey(item)).toBe(key);
  });

  it("reports a part that isn't an upper-case type tag as ?", () => {
    expect(shapeKey({ PK: "OTP#482913", SK: "482913" })).toBe("OTP#/?");
    expect(shapeKey({ PK: "user@example.test#1", SK: "k9F#x" })).toBe("?/?");
    expect(shapeKey({ PK: "session#abc", SK: "Token" })).toBe("?/?");
    expect(shapeKey({ SK: 7 })).toBe("?/?");
  });
});

describe("redactItem: emails", () => {
  it("keeps the allowlisted attributes as they are", () => {
    const out = redactItem(email({ id: "01J9", unsolicited: true }))!;
    expect(out).toMatchObject({
      PK: "MAILBOX#482913",
      SK: "EMAIL#01J9ZQ4Y7N8M2K5T3V6W0X1Y2Z",
      id: "01J9",
      messageId: "<abc@mail.example.test>",
      from: "noreply@example.test",
      receivedAt: "2026-09-01T12:00:00.000Z",
      rawS3Key: "raw/abc",
      auth: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
      unsolicited: true,
      expiresAt: 1788000000,
      subject: "Welcome aboard",
    });
  });

  it("replaces the body text and empties the links", () => {
    const out = redactItem(email())!;
    expect(out.text).toBe(REDACTED_TEXT);
    expect(out.links).toEqual([]);
  });

  it("marks a body that lived in S3 as redacted too", () => {
    const { text: _text, ...inS3 } = email({ bodyS3Key: "bodies/abc" });
    const out = redactItem(inS3)!;
    expect(out.text).toBe(REDACTED_TEXT);
    expect(out).not.toHaveProperty("bodyS3Key");
  });

  it("removes html, bodyS3Key and any attribute outside the allowlist", () => {
    const out = redactItem(email({ bodyS3Key: "bodies/abc", headers: { "x-secret": "s" }, futureField: "s" }))!;
    expect(Object.keys(out).sort()).toEqual([
      "PK", "SK", "auth", "expiresAt", "from", "links", "messageId", "rawS3Key", "receivedAt", "subject", "text",
    ]);
  });

  it("masks codes and links in the subject", () => {
    const out = redactItem(email({ subject: "Your code is 482913 — or visit https://example.test/r?t=1234" }))!;
    expect(out.subject).toBe(`Your code is ${MASK} — or visit ${MASK}`);
  });

  it("does not add a subject the item did not have, nor keep one that is not a string", () => {
    const { subject: _subject, ...noSubject } = email();
    expect(redactItem(noSubject)).not.toHaveProperty("subject");
    expect(redactItem(email({ subject: ["Code 482913"] }))).not.toHaveProperty("subject");
  });

  it("does not modify its input", () => {
    const item = email();
    const before = structuredClone(item);
    redactItem(item);
    expect(item).toEqual(before);
  });
});

describe("maskSubject: per whitespace-separated token", () => {
  it.each([
    // The spec's examples.
    ["Your verification code is 123 456", "Your verification code is •••• ••••"],
    ["Sign in at login.example.test/magic/k9F", "Sign in at ••••"],
    ["Welcome to the fleet", "Welcome to the fleet"],
    ["PR #12 merged", "PR •••• merged"],
    // Code formats a digit-run rule misses.
    ["Code: 123-456", "Code: ••••"],
    ["Code 12 34 56", "Code •••• •••• ••••"],
    ["Code 1.2.3.4.5.6", "Code ••••"],
    ["Code X4K-9PQ", "Code ••••"],
    ["Code AB12CD", "Code ••••"],
    ["Code (1234).", "Code ••••"],
    // Unicode digits: full-width (Nd), and superscript / circled (No, and NFKC digits).
    ["Code １２３４５６", "Code ••••"],
    ["Code ¹²³⁴⁵⁶", "Code ••••"],
    ["Code ①②③", "Code ••••"],
    // Links, hosts, paths and addresses, with or without a scheme.
    ["see https://a.test/x and www.b.test", "see •••• and ••••"],
    ["token in HTTPS://A.TEST", "token in ••••"],
    ["open www.example", "open ••••"],
    ["open example.test", "open ••••"],
    ["path /magic/k9F", "path ••••"],
    ["mail user@example.test now", "mail •••• now"],
    ["host ｌｏｇｉｎ．ｅｘａｍｐｌｅ．ｔｅｓｔ", "host ••••"],
    ["full-width ｋ９Ｆ／ｘ", "full-width ••••"],
    // Plain words and punctuation stay, and so does the spacing.
    ["Hello, world. Welcome!", "Hello, world. Welcome!"],
    ["  two  spaces\tand a tab ", "  two  spaces\tand a tab "],
    ["", ""],
  ])("%j → %j", (input, expected) => {
    expect(maskSubject(input)).toBe(expected);
  });
});

// A seeded generator, so a failure reproduces.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A subject token the masking must not let through: any digit, or anything
 *  that looks like a host, path, address or link. */
const leaks = (token: string) =>
  token !== MASK && (/\p{Nd}/u.test(token) || /[/@]|\.\p{L}|https?:|www\./iu.test(token.normalize("NFKC")));

describe("nothing sensitive survives", () => {
  it("leaves no body, html, link, digit or host/path token, stray attribute or unlisted item shape", () => {
    const rand = rng(20260929);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
    const fullWidth = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
    const secrets: string[] = [];
    const items: Record<string, unknown>[] = [];
    let listed = 0;

    // Every code format in the spec's corpus, plus random ones.
    const codes = () => {
      const n = String(int(100000, 999999));
      return [
        `${n.slice(0, 3)} ${n.slice(3)}`,
        `${n.slice(0, 3)}-${n.slice(3)}`,
        `${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4)}`,
        n.split("").join("."),
        `X${n[0]}K-${n[1]}PQ`,
        `AB${n.slice(0, 2)}CD`,
        fullWidth(n),
        String(int(1000, 99_999_999)),
      ];
    };

    for (let i = 0; i < 400; i++) {
      // Every code format meets every subject template and link form.
      const code = codes()[i % 8];
      const template = Math.floor(i / 8) % 4;
      const token = hex(24);
      const link = [
        `https://login.example.test/magic?token=${token}`,
        `http://x.test/${token}`,
        `www.example.test/r/${token}`,
        `login.example.test/magic/${token}`, // scheme-less magic link
      ][i % 4];
      const body = `Your one-time code is ${code}. Or sign in at ${link} (${hex(16)})`;
      const extra = `secret-${hex(20)}`;
      secrets.push(body, `<p>${body}</p>`, link, token, extra);
      items.push({
        PK: `MAILBOX#${int(100000, 999999)}`,
        SK: `EMAIL#${hex(26).toUpperCase()}`,
        messageId: `<${hex(12)}@mail.example.test>`,
        from: "no-reply@example.test",
        subject: [`Code ${code}`, `${code} is your code`, `Sign in: ${link}`, `Verify ${code} at ${link}`][template],
        receivedAt: "2026-09-01T12:00:00.000Z",
        text: body,
        html: `<p>${body}</p>`,
        links: [link],
        rawS3Key: `raw/${hex(12)}`,
        ...(i % 2 ? { bodyS3Key: `bodies/${extra}` } : { apiKey: extra }),
        expiresAt: 1788000000,
      });
      listed++;

      // Credential hashes, nonces, and shapes no writer produces today.
      for (const [PK, SK] of [
        [`FLEET#${hex(64)}`, "FLEET"],
        [`ADMINKEY#${hex(64)}`, "ADMINKEY"],
        [`VIEWER#${hex(64)}`, "VIEWER"],
        [`NONCE#${hex(16)}`, `SIG#${hex(43)}`],
        [`MAILBOX#${int(100000, 999999)}`, "META"],
        [`OTP#${int(100000, 999999)}`, "OTP"],
        [`AGENT#${hex(16)}`, `SESSION#${int(1, 9)}`],
      ]) {
        // A marker unique to this item: if the item survived, so would it.
        const secret = `unlisted-${hex(24)}`;
        secrets.push(secret);
        items.push({ PK, SK, secret, code });
      }

      // The listed non-mail shapes, which must still come through.
      if (i % 4 === 0) {
        const fp = hex(16);
        items.push(
          { PK: `AGENT#${fp}`, SK: "AGENT", agentId: String(int(100000, 999999)) },
          { PK: `ADDR#${int(100000, 999999)}`, SK: "ADDR", fingerprint: fp },
          { PK: `AGENT#${fp}`, SK: `ACT#${hex(10)}`, kind: "pr" },
          { PK: `AGENT#${fp}`, SK: "STATUS", state: "idle" },
        );
        listed += 4;
      }
    }

    const out = items.map(redactItem).filter((x): x is Record<string, unknown> => x !== null);
    expect(out).toHaveLength(listed);
    const dump = JSON.stringify(out);
    for (const secret of secrets) expect(dump).not.toContain(secret);
    for (const item of out) {
      expect(shapeOf(item)).not.toBeNull();
      if (shapeOf(item) !== "email") continue;
      expect(item.text).toBe(REDACTED_TEXT);
      expect(item.links).toEqual([]);
      expect(item).not.toHaveProperty("html");
      expect(item).not.toHaveProperty("bodyS3Key");
      expect(item).not.toHaveProperty("apiKey");
      const tokens = String(item.subject).split(/\s+/u).filter(Boolean);
      expect(tokens.filter(leaks)).toEqual([]);
    }
  });
});
