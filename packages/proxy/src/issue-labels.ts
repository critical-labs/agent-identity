import type { RepoRef } from "@agent-identity/shared";
import { ForgeError } from "./forge.js";

/** Map the labels an agent asked for onto the labels the repo already
 *  defines (#144), returning them in the repo's own spelling, de-duplicated.
 *  An exact match wins; otherwise the match is case-insensitive (GitHub
 *  treats label names case-insensitively, and an agent should not have to
 *  guess "Bug" vs "bug"). Any label with no match refuses the whole request
 *  with ForgeError("invalid") — the proxy never creates a label, because a
 *  label is repo configuration that belongs to the maintainers. */
export function matchLabels(ref: RepoRef, wanted: string[], existing: string[]): string[] {
  const out: string[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const hit = existing.find((e) => e === w)
      ?? existing.find((e) => e.toLowerCase() === w.toLowerCase());
    if (hit === undefined) {
      if (!unknown.includes(w)) unknown.push(w);
    } else if (!out.includes(hit)) {
      out.push(hit);
    }
  }
  if (unknown.length > 0) {
    throw new ForgeError("invalid",
      `unknown label(s) on ${ref.owner}/${ref.name}: ${unknown.map((u) => `"${u}"`).join(", ")}. `
      + "The proxy applies only labels that already exist in the repo and never creates them; "
      + "use an existing label, or file without it and ask a maintainer to add the label.", 422);
  }
  return out;
}
