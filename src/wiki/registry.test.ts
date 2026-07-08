import { test, expect, describe } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  buildWikiRegistry,
  findWiki,
  listWikis,
  defaultWiki,
  resolveWikiRequest,
  type WikiRegistryEntry,
} from "./registry.ts";
import type { BotConfig } from "../bots/config.ts";

/** Minimal BotConfig stubs — only the fields the registry reads. */
function bot(name: string, wikiDir?: string): BotConfig {
  return {
    name,
    dir: `/bots/${name}`,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    wikiDir,
  } as BotConfig;
}

const BOTS = [
  bot("jarvis", "/abs/huginn-jarvis/data/wiki"),
  bot("melosys", "/abs/huginn-nav/wiki"),
  bot("nowiki"), // discovered bot without a configured wiki
];

const REPO = "/repo/muninn";

describe("buildWikiRegistry", () => {
  test("bot wikis only (no extra) — one entry per wikiDir bot, in order", () => {
    expect(buildWikiRegistry(BOTS, undefined, REPO)).toEqual([
      { name: "jarvis", root: "/abs/huginn-jarvis/data/wiki", source: "bot" },
      { name: "melosys", root: "/abs/huginn-nav/wiki", source: "bot" },
    ]);
  });

  test("extra wikis: absolute path passes through, relative resolves against repo root", () => {
    const reg = buildWikiRegistry(
      [bot("jarvis", "/w")],
      "mimir=../mimir, kode=/Users/rune/source/nav/melosys-kode-wiki",
      REPO,
    );
    expect(reg).toEqual([
      { name: "jarvis", root: "/w", source: "bot" },
      { name: "mimir", root: "/repo/mimir", source: "extra" },
      { name: "kode", root: "/Users/rune/source/nav/melosys-kode-wiki", source: "extra" },
    ]);
  });

  test("trims whitespace around names and paths", () => {
    const reg = buildWikiRegistry([], "  mimir  =  ../mimir  ", REPO);
    expect(reg).toEqual([{ name: "mimir", root: "/repo/mimir", source: "extra" }]);
  });

  test("skips malformed pairs (no '=', empty name, empty path) but keeps the rest", () => {
    const reg = buildWikiRegistry([], "garbage, =/x, mimir=, ok=../ok", REPO);
    expect(reg).toEqual([{ name: "ok", root: "/repo/ok", source: "extra" }]);
  });

  test("skips an extra whose name collides with a bot wiki (case-insensitive)", () => {
    const reg = buildWikiRegistry([bot("Jarvis", "/w")], "jarvis=../elsewhere,mimir=../mimir", REPO);
    expect(reg).toEqual([
      { name: "Jarvis", root: "/w", source: "bot" },
      { name: "mimir", root: "/repo/mimir", source: "extra" },
    ]);
  });

  test("skips a duplicate extra name (first wins)", () => {
    const reg = buildWikiRegistry([], "mimir=../a,mimir=../b", REPO);
    expect(reg).toEqual([{ name: "mimir", root: "/repo/a", source: "extra" }]);
  });

  test("expands a leading ~ / ~/ to the home dir (not <repo>/~/…)", () => {
    const home = os.homedir();
    const reg = buildWikiRegistry([], "notes=~/n/wiki, home=~", REPO);
    expect(reg).toEqual([
      { name: "notes", root: path.join(home, "n/wiki"), source: "extra" },
      { name: "home", root: home, source: "extra" },
    ]);
  });
});

const REG: WikiRegistryEntry[] = [
  { name: "jarvis", root: "/abs/huginn-jarvis/data/wiki", source: "bot" },
  { name: "melosys", root: "/abs/huginn-nav/wiki", source: "bot" },
  { name: "mimir", root: "/repo/mimir", source: "extra" },
];

describe("findWiki", () => {
  test("no/blank name → undefined", () => {
    expect(findWiki(REG, undefined)).toBeUndefined();
    expect(findWiki(REG, "")).toBeUndefined();
    expect(findWiki(REG, "  ")).toBeUndefined();
  });

  test("known wiki (bot or extra) → its entry", () => {
    expect(findWiki(REG, "melosys")).toEqual(REG[1]);
    expect(findWiki(REG, "mimir")).toEqual(REG[2]);
  });

  test("match is case-insensitive and trims whitespace", () => {
    expect(findWiki(REG, "  MIMIR ")).toEqual(REG[2]);
  });

  test("unknown wiki → undefined", () => {
    expect(findWiki(REG, "ghost")).toBeUndefined();
  });
});

describe("listWikis", () => {
  test("lists every registered wiki, bot + extra", () => {
    expect(listWikis(REG)).toEqual(["jarvis", "melosys", "mimir"]);
  });
});

describe("defaultWiki", () => {
  test("prefers jarvis", () => {
    expect(defaultWiki(REG)).toBe("jarvis");
  });

  test("matches jarvis case-insensitively", () => {
    expect(defaultWiki([{ name: "Jarvis", root: "/w", source: "bot" }])).toBe("Jarvis");
  });

  test("falls back to the first entry when jarvis is absent", () => {
    expect(defaultWiki([{ name: "mimir", root: "/m", source: "extra" }])).toBe("mimir");
  });

  test("undefined for an empty registry", () => {
    expect(defaultWiki([])).toBeUndefined();
  });
});

describe("resolveWikiRequest", () => {
  const jarvis = REG[0];
  const melosys = REG[1];
  const mimir = REG[2];

  test("known wiki → canonical name (case-corrected) + entry, no env override", () => {
    expect(resolveWikiRequest(REG, "MIMIR", undefined, undefined)).toEqual({
      wiki: "mimir",
      envOverride: false,
      entry: mimir,
      unknownWiki: false,
    });
    expect(resolveWikiRequest(REG, "  melosys ", undefined, undefined)).toEqual({
      wiki: "melosys",
      envOverride: false,
      entry: melosys,
      unknownWiki: false,
    });
  });

  test("?wiki= wins over the ?bot= alias when both are present", () => {
    expect(resolveWikiRequest(REG, "mimir", "melosys", undefined)).toEqual({
      wiki: "mimir",
      envOverride: false,
      entry: mimir,
      unknownWiki: false,
    });
  });

  test("falls back to the ?bot= alias when ?wiki= is absent/blank", () => {
    expect(resolveWikiRequest(REG, undefined, "melosys", undefined)).toEqual({
      wiki: "melosys",
      envOverride: false,
      entry: melosys,
      unknownWiki: false,
    });
    expect(resolveWikiRequest(REG, "  ", "melosys", undefined)).toEqual({
      wiki: "melosys",
      envOverride: false,
      entry: melosys,
      unknownWiki: false,
    });
  });

  test("unknown name is echoed back with unknownWiki so the client hits the empty state", () => {
    expect(resolveWikiRequest(REG, "ghost", undefined, undefined)).toEqual({
      wiki: "ghost",
      envOverride: false,
      entry: undefined,
      unknownWiki: true,
    });
  });

  test("a discovered bot WITHOUT a wikiDir is absent → unknown/empty state (no silent default)", () => {
    // `nowiki` is discovered but carries no wikiDir, so buildWikiRegistry drops it.
    const reg = buildWikiRegistry(BOTS, undefined, REPO);
    expect(resolveWikiRequest(reg, "nowiki", undefined, undefined)).toEqual({
      wiki: "nowiki",
      envOverride: false,
      entry: undefined,
      unknownWiki: true,
    });
  });

  test("bare /wiki resolves the default wiki entry (same root as ?wiki=<default>)", () => {
    expect(resolveWikiRequest(REG, undefined, undefined, undefined)).toEqual({
      wiki: "jarvis",
      envOverride: false,
      entry: jarvis,
      unknownWiki: false,
    });
  });

  test("bare /wiki with WIKI_DIR set → env override, no wiki/entry claimed", () => {
    expect(resolveWikiRequest(REG, undefined, undefined, "/some/wiki")).toEqual({
      wiki: "",
      envOverride: true,
      entry: undefined,
      unknownWiki: false,
    });
    // whitespace-only env is treated as unset
    expect(resolveWikiRequest(REG, undefined, undefined, "  ")).toEqual({
      wiki: "jarvis",
      envOverride: false,
      entry: jarvis,
      unknownWiki: false,
    });
  });

  test("an explicit wiki/bot wins over the WIKI_DIR override", () => {
    expect(resolveWikiRequest(REG, "mimir", undefined, "/some/wiki")).toEqual({
      wiki: "mimir",
      envOverride: false,
      entry: mimir,
      unknownWiki: false,
    });
    expect(resolveWikiRequest(REG, undefined, "melosys", "/some/wiki")).toEqual({
      wiki: "melosys",
      envOverride: false,
      entry: melosys,
      unknownWiki: false,
    });
  });

  test("empty registry → empty wiki, store's own fallback serves content", () => {
    expect(resolveWikiRequest([], undefined, undefined, undefined)).toEqual({
      wiki: "",
      envOverride: false,
      entry: undefined,
      unknownWiki: false,
    });
  });
});
