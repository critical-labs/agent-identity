import { describe, expect, it } from "vitest";
import { extractLinks, parseEmail } from "./parse.js";

const RAW = Buffer.from([
  "From: GitHub <noreply@github.com>",
  "To: 482913@mail.example.com",
  "Subject: Please verify",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Hi. <a href="https://github.com/verify?t=abc">Verify</a> or visit https://github.com/help</p>',
].join("\r\n"));

describe("parseEmail", () => {
  it("extracts from, subject, text, html and links", async () => {
    const parsed = await parseEmail(RAW);
    expect(parsed.from).toContain("noreply@github.com");
    expect(parsed.subject).toBe("Please verify");
    expect(parsed.links).toContain("https://github.com/verify?t=abc");
    expect(parsed.links).toContain("https://github.com/help");
    expect(parsed.text).toContain("Hi.");
  });
});

describe("extractLinks", () => {
  it("dedupes and strips trailing punctuation", () => {
    const links = extractLinks(
      "see https://a.example/x. and https://a.example/x",
      '<a href="https://b.example/y">y</a>',
    );
    expect(links).toEqual(["https://a.example/x", "https://b.example/y"]);
  });

  it("decodes HTML entities in links extracted from HTML", () => {
    const links = extractLinks(
      "",
      '<a href="https://e.example/verify?a=1&amp;b=2">verify</a>',
    );
    expect(links).toContain("https://e.example/verify?a=1&b=2");
    expect(links).not.toContain("https://e.example/verify?a=1&amp;b=2");
  });

  it("decodes numeric character references in HTML links", () => {
    const links = extractLinks(
      "",
      '<a href="https://e.example/?d=1&#38;e=2&#x26;f=3">x</a>',
    );
    expect(links).toContain("https://e.example/?d=1&e=2&f=3");
  });

  it("tolerates out-of-range numeric references without throwing", () => {
    const links = extractLinks("", '<a href="https://e.example/?bad=&#99999999;">x</a>');
    expect(links).toContain("https://e.example/?bad=&#99999999;");
  });

  it("leaves plain-text URLs undecoded", () => {
    const links = extractLinks("literal https://e.example/?a=1&amp;b=2 here");
    expect(links).toEqual(["https://e.example/?a=1&amp;b=2"]);
  });
});
