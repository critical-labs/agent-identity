/** Attribution footers the proxy appends to PR/MR bodies, issue bodies, and
 *  comments:
 *  `_opened by agent 482913 via agent-identity proxy_`,
 *  `_description updated by agent 482913 via agent-identity proxy_`.
 *  A footer is a whole line of exactly this shape; the agent id is digits. */
const FOOTER = /^_[a-z ]+ by agent \d+ via agent-identity proxy_$/;

function footerLines(body: string): string[] {
  return body.split("\n").map((l) => l.trimEnd()).filter((l) => FOOTER.test(l));
}

/** The body to store after an update: the agent's NEW text (with any footer
 *  lines it carried stripped — attribution is the proxy's to write, never the
 *  agent's), then a blank line, then every proxy footer the OLD body already
 *  carried, in order and de-duplicated, then the new attribution line. So a
 *  rewritten description still says who opened the PR and who rewrote it. */
export function withProxyFooters(oldBody: string, newBody: string, attribution: string): string {
  const text = newBody.split("\n").filter((l) => !FOOTER.test(l.trimEnd())).join("\n").trimEnd();
  const carried: string[] = [];
  for (const line of footerLines(oldBody)) {
    if (!carried.includes(line)) carried.push(line);
  }
  const footers = [...carried.filter((l) => l !== attribution), attribution];
  return `${text}\n\n${footers.join("\n")}`;
}
