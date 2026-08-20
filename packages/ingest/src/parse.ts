import { simpleParser } from "mailparser";

export interface ParsedEmail {
  from: string;
  subject: string;
  text: string;
  html?: string;
  links: string[];
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

// &amp; must decode last so "&amp;lt;" becomes "&lt;", not "<".
const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (m, d: string) => {
      const n = Number(d);
      return n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => {
      const n = Number.parseInt(h, 16);
      return n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export function extractLinks(text: string, html?: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_RE)) found.add(m[0].replace(/[.,;:]+$/, ""));
  if (html) {
    for (const m of html.matchAll(/href="([^"]+)"/g))
      if (m[1].startsWith("http")) found.add(decodeEntities(m[1]));
    for (const m of html.matchAll(URL_RE))
      found.add(decodeEntities(m[0]).replace(/[.,;:]+$/, ""));
  }
  return [...found];
}

export async function parseEmail(raw: Buffer): Promise<ParsedEmail> {
  const mail = await simpleParser(raw);
  const text = mail.text ?? "";
  const html = typeof mail.html === "string" ? mail.html : undefined;
  return {
    from: mail.from?.text ?? "",
    subject: mail.subject ?? "",
    text,
    html,
    links: extractLinks(text, html),
  };
}
