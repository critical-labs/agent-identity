import { describe, expect, it } from "vitest";
import { REDACTED_TEXT, maskSubject, redactItem } from "./redact.js";

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

describe("redactItem: dropped items", () => {
  it.each(["FLEET#", "ADMINKEY#", "VIEWER#", "NONCE#"])("drops %s items (key hashes and nonces)", (prefix) => {
    expect(redactItem({ PK: `${prefix}9f86d081884c7d65`, SK: prefix.slice(0, -1) })).toBeNull();
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
    expect(out.subject).toBe("Your code is •••• — or visit [link]");
  });

  it("does not add a subject the item did not have", () => {
    const { subject: _subject, ...noSubject } = email();
    expect(redactItem(noSubject)).not.toHaveProperty("subject");
  });

  it("does not modify its input", () => {
    const item = email();
    const before = structuredClone(item);
    redactItem(item);
    expect(item).toEqual(before);
  });
});

describe("redactItem: everything else", () => {
  it.each([
    { PK: "AGENT#fp1", SK: "AGENT", agentId: "482913", address: "482913@mail.example.test", status: "active" },
    { PK: "ADDR#482913", SK: "ADDR", fingerprint: "fp1" },
    { PK: "AGENT#482913", SK: "ACT#01J9", kind: "pr", repo: "o/r", title: "Fix 12345" },
    { PK: "AGENT#482913", SK: "STATUS", state: "working" },
    { PK: "MAILBOX#482913", SK: "META", note: "not an email" },
  ])("copies $PK/$SK unchanged", (item) => {
    const out = redactItem(item);
    expect(out).toEqual(item);
    expect(out).not.toBe(item);
  });
});

describe("maskSubject", () => {
  it.each([
    ["Login code 1234", "Login code ••••"],
    ["Order 12345678 shipped", "Order •••• shipped"],
    ["Meet at 10:30 on day 7", "Meet at 10:30 on day 7"],
    ["see http://a.test/x and www.b.test/y?z=1", "see [link] and [link]"],
    ["token in HTTPS://A.TEST/9999", "token in [link]"],
    ["codes 1234-5678", "codes ••••-••••"],
  ])("%s → %s", (input, expected) => {
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

describe("nothing sensitive survives", () => {
  it("leaves no body, html, link, code-like digit run, stray attribute or key-hash item", () => {
    const rand = rng(20260929);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
    const secrets: string[] = [];
    const items: Record<string, unknown>[] = [];

    for (let i = 0; i < 300; i++) {
      const code = String(int(1000, 99_999_999));
      const token = hex(24);
      const link = [`https://login.example.test/magic?token=${token}`, `http://x.test/${token}`, `www.example.test/r/${token}`][i % 3];
      const body = `Your one-time code is ${code}. Or sign in at ${link} (${hex(16)})`;
      const extra = `secret-${hex(20)}`;
      secrets.push(body, `<p>${body}</p>`, link, token, extra);
      items.push({
        PK: `MAILBOX#${int(100000, 999999)}`,
        SK: `EMAIL#${hex(26).toUpperCase()}`,
        messageId: `<${hex(12)}@mail.example.test>`,
        from: "no-reply@example.test",
        subject: [`Code ${code}`, `${code} is your code`, `Sign in: ${link}`, `Verify ${code} at ${link}`][i % 4],
        receivedAt: "2026-09-01T12:00:00.000Z",
        text: body,
        html: `<p>${body}</p>`,
        links: [link],
        rawS3Key: `raw/${hex(12)}`,
        ...(i % 2 ? { bodyS3Key: `bodies/${extra}` } : { apiKey: extra }),
        expiresAt: 1788000000,
      });
      for (const prefix of ["FLEET#", "ADMINKEY#", "VIEWER#", "NONCE#"]) {
        const hash = hex(64);
        secrets.push(hash);
        items.push({ PK: `${prefix}${hash}`, SK: prefix.slice(0, -1) });
      }
    }

    const out = items.map(redactItem).filter((x): x is Record<string, unknown> => x !== null);
    const dump = JSON.stringify(out);
    for (const secret of secrets) expect(dump).not.toContain(secret);
    for (const item of out) {
      expect(String(item.PK)).toMatch(/^MAILBOX#/);
      expect(item.text).toBe(REDACTED_TEXT);
      expect(item.links).toEqual([]);
      expect(item).not.toHaveProperty("html");
      expect(item).not.toHaveProperty("bodyS3Key");
      expect(item).not.toHaveProperty("apiKey");
      expect(String(item.subject)).not.toMatch(/\d{4,}/);
      expect(String(item.subject)).not.toMatch(/https?:|www\./i);
    }
    expect(out).toHaveLength(300);
  });
});
