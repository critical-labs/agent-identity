import { describe, expect, it, vi } from "vitest";
import { processRecord, type IngestDeps } from "./handler.js";

const sesRecord = (over: Record<string, unknown> = {}) => ({
  ses: {
    mail: { messageId: "m1", timestamp: "2026-07-04T10:00:00.000Z" },
    receipt: {
      recipients: ["482913@mail.example.com"],
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
      ...over,
    },
  },
});

function makeDeps(): IngestDeps {
  return {
    getRaw: vi.fn(async () => Buffer.from(
      "From: a@b.c\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello https://x.example/1",
    )),
    putBodyOverflow: vi.fn(async () => "bodies/482913/X.json"),
    agents: { getByLocalPart: vi.fn(async (id: string) =>
      id === "482913" ? { agentId: "482913", status: "active" } : undefined,
    )} as never,
    emails: { putEmail: vi.fn(async () => "01ABC") } as never,
    maxInlineBodyBytes: 300_000,
  };
}

describe("processRecord", () => {
  it("stores parsed email for a known recipient", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord() as never, deps);
    expect(deps.emails.putEmail).toHaveBeenCalledWith("482913", expect.objectContaining({
      from: expect.stringContaining("a@b.c"),
      subject: "s",
      receivedAt: "2026-07-04T10:00:00.000Z",
      links: ["https://x.example/1"],
      rawS3Key: "raw/m1",
    }));
  });

  it("drops spam", async () => {
    const deps = makeDeps();
    await processRecord(sesRecord({ spamVerdict: { status: "FAIL" } }) as never, deps);
    expect(deps.emails.putEmail).not.toHaveBeenCalled();
  });

  it("drops unknown recipients", async () => {
    const deps = makeDeps();
    const rec = sesRecord({ recipients: ["999999@mail.example.com"] });
    await processRecord(rec as never, deps);
    expect(deps.emails.putEmail).not.toHaveBeenCalled();
  });

  it("lets mail through when verdict objects are absent (scanning disabled)", async () => {
    const deps = makeDeps();
    const record = {
      ses: {
        mail: { messageId: "m1", timestamp: "2026-07-04T10:00:00.000Z" },
        receipt: {
          recipients: ["482913@mail.example.com"],
          // no spamVerdict / virusVerdict keys at all
        },
      },
    };
    await expect(processRecord(record as never, deps)).resolves.toBeUndefined();
    expect(deps.emails.putEmail).toHaveBeenCalled();
  });

  it("offloads oversized bodies to S3", async () => {
    const deps = { ...makeDeps(), maxInlineBodyBytes: 4 };
    await processRecord(sesRecord() as never, deps);
    expect(deps.putBodyOverflow).toHaveBeenCalled();
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.bodyS3Key).toBe("bodies/482913/X.json");
    expect(stored.text).toBeUndefined();
  });
});
