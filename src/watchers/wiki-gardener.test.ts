import { test, expect, describe } from "bun:test";
import { buildGardenerSeams } from "./wiki-gardener.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";

const CONFIG = {} as Config;

function ctx(wikiCollections?: string[]) {
  const botConfig = {
    name: "jarvis",
    connector: "claude-cli",
    wikiDir: "/tmp/wiki",
    wikiCollections,
  } as unknown as BotConfig;
  return { botConfig, config: CONFIG, apiUrl: "http://localhost:8321", wikiDir: "/tmp/wiki" };
}

describe("buildGardenerSeams — searchRelated threading (silent no-op regression)", () => {
  test("provides searchRelated when wikiCollections is set", () => {
    const seams = buildGardenerSeams(ctx(["wiki", "wiki-life"]));
    expect(typeof seams.searchRelated).toBe("function");
  });

  test("omits searchRelated when wikiCollections is unset", () => {
    const seams = buildGardenerSeams(ctx(undefined));
    expect(seams.searchRelated).toBeUndefined();
  });

  test("omits searchRelated when wikiCollections is empty / all-blank", () => {
    expect(buildGardenerSeams(ctx([])).searchRelated).toBeUndefined();
    expect(buildGardenerSeams(ctx(["", "  "])).searchRelated).toBeUndefined();
  });
});
