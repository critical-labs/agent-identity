import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fleetKeyPath, readFleetKeyFile, readMachineConfig, resolveFleetKey,
  writeFleetKeyFile, writeMachineConfig,
} from "./config.js";

const base = () => mkdtempSync(join(tmpdir(), "aid-cfg-"));

describe("machine config", () => {
  it("round-trips apiUrl and writes mode 600", () => {
    const dir = base();
    writeMachineConfig({ apiUrl: "https://api.example" }, dir);
    expect(readMachineConfig(dir)).toEqual({ apiUrl: "https://api.example" });
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
  });

  it("returns {} when missing or corrupt", () => {
    const dir = base();
    expect(readMachineConfig(dir)).toEqual({});
    writeFileSync(join(dir, "config.json"), "{bad json");
    expect(readMachineConfig(dir)).toEqual({});
  });
});

describe("fleet key file", () => {
  it("round-trips trimmed key with mode 600", () => {
    const dir = base();
    writeFleetKeyFile("  fk-123\n", dir);
    expect(readFleetKeyFile(dir)).toBe("fk-123");
    expect(statSync(fleetKeyPath(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(fleetKeyPath(dir), "utf8")).toBe("fk-123\n");
  });

  it("returns undefined when missing or empty", () => {
    const dir = base();
    expect(readFleetKeyFile(dir)).toBeUndefined();
    writeFleetKeyFile("", dir);
    expect(readFleetKeyFile(dir)).toBeUndefined();
  });
});

describe("resolveFleetKey", () => {
  it("prefers the env value over the file", () => {
    const dir = base();
    writeFleetKeyFile("from-file", dir);
    expect(resolveFleetKey("from-env", dir)).toBe("from-env");
  });

  it("falls back to the file, then undefined", () => {
    const dir = base();
    expect(resolveFleetKey(undefined, dir)).toBeUndefined();
    writeFleetKeyFile("from-file", dir);
    expect(resolveFleetKey(undefined, dir)).toBe("from-file");
    expect(resolveFleetKey("", dir)).toBe("from-file"); // empty env = unset
  });
});
