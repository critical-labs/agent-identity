import { describe, expect, it, vi, afterEach } from "vitest";
import { processRecord, processEvent, type IngestDeps } from "./handler.js";

const sesRecord = (over: Record<string, unknown> = {}, messageId = "m1") => ({
  ses: {
    mail: { messageId, timestamp: "2026-07-04T10:00:00.000Z" },
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

describe("processEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("continues past a failing record and processes remaining records", async () => {
    // Record 2 (messageId "m2") will throw; records 1 and 3 must still be stored.
    const putEmail = vi.fn(async () => "ok");
    const deps: IngestDeps = {
      getRaw: vi.fn(async (key: string) => {
        if (key === "raw/m2") throw new Error("malformed MIME");
        return Buffer.from(
          "From: a@b.c\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello https://x.example/1",
        );
      }),
      putBodyOverflow: vi.fn(async () => "bodies/482913/X.json"),
      agents: { getByLocalPart: vi.fn(async (id: string) =>
        id === "482913" ? { agentId: "482913", status: "active" } : undefined,
      )} as never,
      emails: { putEmail } as never,
      maxInlineBodyBytes: 300_000,
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const event = {
      Records: [
        sesRecord({}, "m1"),
        sesRecord({}, "m2"),
        sesRecord({}, "m3"),
      ],
    } as never;

    // Must not throw even though record 2 fails
    await expect(processEvent(event, deps)).resolves.toBeUndefined();

    // Records 1 and 3 must have been stored
    expect(putEmail).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storedIds = (putEmail.mock.calls as any[][]).map((c) => (c[1] as { rawS3Key: string }).rawS3Key);
    expect(storedIds).toContain("raw/m1");
    expect(storedIds).toContain("raw/m3");

    // console.error must have been called with the failing messageId
    expect(errorSpy).toHaveBeenCalledWith(
      "ingest: failed to process record",
      expect.objectContaining({ messageId: "m2" }),
    );
  });
});

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

  it("offloads oversized bodies to S3", async () => {
    const deps = { ...makeDeps(), maxInlineBodyBytes: 4 };
    await processRecord(sesRecord() as never, deps);
    expect(deps.putBodyOverflow).toHaveBeenCalled();
    const stored = (deps.emails.putEmail as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored.bodyS3Key).toBe("bodies/482913/X.json");
    expect(stored.text).toBeUndefined();
  });
});
