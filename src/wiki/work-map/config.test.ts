import { afterEach, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { EFFORT_VALUES } from "../../bots/config.ts";
import { __resetEnvFlagWarningsForTest, WORK_MAP_DEFAULT_MODEL, WORK_MAP_EFFORT_VALUES, workMapEnv } from "../../config.ts";
import { AMBIENT_INSTANCE_ENV } from "../../test/ambient-env.ts";

test("WORK_MAP_* defaults: off, 05:00, Opus 5.5, no effort", () => {
  expect(workMapEnv({})).toEqual({ workMapWikis: [], workMapHour: 5, workMapModel: WORK_MAP_DEFAULT_MODEL, workMapEffort: undefined });
  expect(WORK_MAP_DEFAULT_MODEL).toBe("claude-opus-5-5");
});

test("WORK_MAP_* parse: names trimmed, hour 0–23, a known effort", () => {
  expect(workMapEnv({ WORK_MAP_WIKIS: " mimir, melosys-kode-wiki ,", WORK_MAP_HOUR: "0", WORK_MAP_MODEL: "claude-sonnet-5", WORK_MAP_EFFORT: "high" })).toEqual({
    workMapWikis: ["mimir", "melosys-kode-wiki"],
    workMapHour: 0,
    workMapModel: "claude-sonnet-5",
    workMapEffort: "high",
  });
});

test("a bad WORK_MAP_HOUR or WORK_MAP_EFFORT falls back instead of failing boot", () => {
  for (const bad of ["24", "-1", "5.5", "five"]) {
    expect(workMapEnv({ WORK_MAP_WIKIS: "mimir", WORK_MAP_HOUR: bad })).toMatchObject({ workMapWikis: ["mimir"], workMapHour: 5 });
  }
  expect(workMapEnv({ WORK_MAP_HOUR: "3", WORK_MAP_EFFORT: "turbo" })).toMatchObject({ workMapHour: 3, workMapEffort: undefined });
});

test("WORK_MAP_HOUR takes two-digit hours up to 23", () => {
  for (const ok of ["10", "22", "23"]) expect(workMapEnv({ WORK_MAP_HOUR: ok }).workMapHour).toBe(Number(ok));
});

afterEach(async () => {
  __resetEnvFlagWarningsForTest();
  await reset();
});

test("a bad WORK_MAP_HOUR or WORK_MAP_EFFORT warns once per value", async () => {
  __resetEnvFlagWarningsForTest();
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (r: LogRecord) => records.push(r) },
    loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
    reset: true,
  });
  workMapEnv({ WORK_MAP_HOUR: "24", WORK_MAP_EFFORT: "turbo" });
  workMapEnv({ WORK_MAP_HOUR: "24", WORK_MAP_EFFORT: "turbo" });
  workMapEnv({ WORK_MAP_HOUR: "25" });
  const warned = records.filter((r) => r.level === "warning").map((r) => `${r.properties.name}=${r.properties.value}`);
  expect(warned).toEqual(["WORK_MAP_HOUR=24", "WORK_MAP_EFFORT=turbo", "WORK_MAP_HOUR=25"]);
});

test("the effort list is the bots' list, and the four names are ambient-blanked", () => {
  expect([...WORK_MAP_EFFORT_VALUES]).toEqual([...EFFORT_VALUES]);
  for (const name of ["WORK_MAP_WIKIS", "WORK_MAP_HOUR", "WORK_MAP_MODEL", "WORK_MAP_EFFORT"]) expect(AMBIENT_INSTANCE_ENV).toContain(name);
});
