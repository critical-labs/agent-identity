import { simpleParser } from "mailparser";

export interface ParsedEmail {
  from: string;
  subject: string;
  text: string;
  html?: string;
  links: string[];
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export function extractLinks(text: string, html?: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_RE)) found.add(m[0].replace(/[.,;:]+$/, ""));
  if (html) {
    for (const m of html.matchAll(/href="([^"]+)"/g))
      if (m[1].startsWith("http")) found.add(m[1]);
    for (const m of html.matchAll(URL_RE)) found.add(m[0].replace(/[.,;:]+$/, ""));
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
