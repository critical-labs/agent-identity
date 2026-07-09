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
});
