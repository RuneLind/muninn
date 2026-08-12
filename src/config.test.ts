import { test, expect, describe, afterEach } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { optionalEnvFlag, __resetEnvFlagWarningsForTest } from "./config.ts";

/**
 * `optionalEnvFlag` is how the instance-profile switches (`MUNINN_WIKI_READONLY`)
 * are read, and its accept-set is deliberately narrow: `1` / `true`.
 *
 * The failure it now reports is silent-OFF. `MUNINN_WIKI_READONLY=yes` on the Mac
 * mini reads as "writes are allowed here" — the exact configuration mistake the
 * flag exists to prevent, arriving with no signal at all. The value still parses
 * to OFF (fail-open on an unrecognized value is right — a typo must not brick an
 * instance), but it now says so once.
 */
describe("optionalEnvFlag", () => {
  const VAR = "MUNINN_TEST_FLAG";

  /** Capture muninn warnings — the logger is a silent no-op unless configured. */
  async function capture(): Promise<LogRecord[]> {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    return records;
  }

  afterEach(async () => {
    delete process.env[VAR];
    __resetEnvFlagWarningsForTest();
    await reset();
  });

  test("accepts 1/true (case-insensitive, trimmed) and treats absence as OFF", () => {
    for (const raw of ["1", "true", "TRUE", " true ", "True"]) {
      process.env[VAR] = raw;
      expect(`${raw} → ${optionalEnvFlag(VAR)}`).toBe(`${raw} → true`);
    }
    delete process.env[VAR];
    expect(optionalEnvFlag(VAR)).toBe(false);
    process.env[VAR] = "";
    expect(optionalEnvFlag(VAR)).toBe(false);
  });

  test("explicit OFF spellings (0/false/no/off, case-insensitive, trimmed) are OFF and warn about NOTHING", async () => {
    // The warn exists to report SILENT-OFF: a value the operator meant as ON
    // that reads as OFF. `MUNINN_WIKI_READONLY=0` is not that — it is the flag
    // being turned off on purpose, and it got the same "unrecognized" warning as
    // a typo, which teaches operators to ignore the one line that matters.
    // NB the asymmetry with `on` (below) is deliberate, not an oversight: `off`
    // asks for OFF and gets OFF, while `on` asks for ON and silently gets OFF.
    const records = await capture();
    for (const raw of ["0", "false", "FALSE", " false ", "no", "NO", "off", "Off", " 0 "]) {
      process.env[VAR] = raw;
      expect(`${raw} → ${optionalEnvFlag(VAR)}`).toBe(`${raw} → false`);
    }
    expect(records.filter((r) => r.level === "warning")).toEqual([]);
  });

  test("an unrecognized non-empty value warns ONCE, naming the var and that it is OFF", async () => {
    const records = await capture();
    process.env[VAR] = "yes";
    expect(optionalEnvFlag(VAR)).toBe(false);
    // Read again — config flags are read at call time (the readonly seam reads on
    // every write), so a per-call warn would flood the log.
    expect(optionalEnvFlag(VAR)).toBe(false);

    const warns = records.filter((r) => r.level === "warning");
    expect(warns.length).toBe(1);
    const rendered = warns[0]!.message.join("");
    expect(rendered).toContain(VAR);
    expect(rendered).toContain("yes");
    expect(rendered.toLowerCase()).toContain("off");
  });

  test("a recognized value warns about nothing", async () => {
    const records = await capture();
    process.env[VAR] = "1";
    optionalEnvFlag(VAR);
    delete process.env[VAR];
    optionalEnvFlag(VAR);
    expect(records.filter((r) => r.level === "warning")).toEqual([]);
  });

  test("each unrecognized VALUE gets its own warning — a corrected typo is not silent", async () => {
    const records = await capture();
    process.env[VAR] = "on";
    optionalEnvFlag(VAR);
    process.env[VAR] = "2";
    optionalEnvFlag(VAR);
    expect(records.filter((r) => r.level === "warning").length).toBe(2);
  });
});
