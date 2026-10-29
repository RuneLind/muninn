import { expect, test } from "bun:test";
import { EFFORT_VALUES } from "../../bots/config.ts";
import { ConfigError, WORK_MAP_DEFAULT_MODEL, WORK_MAP_EFFORT_VALUES, workMapEnv } from "../../config.ts";
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
  for (const bad of ["24", "-1", "5.5", "five"]) expect(() => workMapEnv({ WORK_MAP_HOUR: bad })).toThrow(ConfigError);
  expect(() => workMapEnv({ WORK_MAP_EFFORT: "turbo" })).toThrow(ConfigError);
});

test("the effort list is the bots' list, and the four names are ambient-blanked", () => {
  expect([...WORK_MAP_EFFORT_VALUES]).toEqual([...EFFORT_VALUES]);
  for (const name of ["WORK_MAP_WIKIS", "WORK_MAP_HOUR", "WORK_MAP_MODEL", "WORK_MAP_EFFORT"]) expect(AMBIENT_INSTANCE_ENV).toContain(name);
});
