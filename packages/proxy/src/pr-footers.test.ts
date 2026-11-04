import { describe, expect, it } from "vitest";
import { withProxyFooters } from "./pr-footers.js";

const opened = "_opened by agent 482913 via agent-identity proxy_";
const updated = "_description updated by agent 777 via agent-identity proxy_";

describe("withProxyFooters", () => {
  it("appends the new attribution after the footers the old body already carried", () => {
    const oldBody = `old text\n\n${opened}`;
    expect(withProxyFooters(oldBody, "new text", updated))
      .toBe(`new text\n\n${opened}\n${updated}`);
  });

  it("keeps every earlier proxy footer, in order, without duplicates", () => {
    const oldBody = `x\n\n${opened}\n${updated}\n${updated}`;
    const again = "_description updated by agent 482913 via agent-identity proxy_";
    expect(withProxyFooters(oldBody, "y", again))
      .toBe(`y\n\n${opened}\n${updated}\n${again}`);
  });

  it("ignores lines that only look like footers", () => {
    const oldBody = "x\n\n_opened by agent zero via agent-identity proxy_\n_not a footer_\n"
      + "_opened by agent 1 via agent-identity proxy_ trailing";
    expect(withProxyFooters(oldBody, "y", updated)).toBe(`y\n\n${updated}`);
  });

  it("drops footers the NEW body tries to carry itself, so an agent cannot forge attribution", () => {
    const newBody = `claims\n\n_opened by agent 1 via agent-identity proxy_`;
    expect(withProxyFooters("", newBody, updated)).toBe(`claims\n\n${updated}`);
  });

  it("works with an empty or footer-less old body", () => {
    expect(withProxyFooters("", "y", updated)).toBe(`y\n\n${updated}`);
    expect(withProxyFooters("plain", "y  \n\n", updated)).toBe(`y\n\n${updated}`);
  });
});
