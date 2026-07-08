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
function bot(name: string, wikiDir?: string, wikiCollections?: string[]): BotConfig {
  return {
    name,
    dir: `/bots/${name}`,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    wikiDir,
    wikiCollections,
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

  test("bot wiki carries its wikiCollections onto the registry entry", () => {
    const reg = buildWikiRegistry([bot("jarvis", "/w", ["wiki", "wiki-life"])], undefined, REPO);
    expect(reg).toEqual([
      { name: "jarvis", root: "/w", source: "bot", collections: ["wiki", "wiki-life"] },
    ]);
  });

  test("bot wiki without wikiCollections has no collections key", () => {
    const [entry] = buildWikiRegistry([bot("jarvis", "/w")], undefined, REPO);
    expect(entry).toEqual({ name: "jarvis", root: "/w", source: "bot" });
    expect(entry!.collections).toBeUndefined();
  });

  test("bot wiki with empty wikiCollections array drops the key (no collections)", () => {
    const [entry] = buildWikiRegistry([bot("jarvis", "/w", [])], undefined, REPO);
    expect(entry).toEqual({ name: "jarvis", root: "/w", source: "bot" });
  });

  test("WIKI_EXTRA 3-segment: parses +-separated collection list", () => {
    const reg = buildWikiRegistry([], "mimir=../mimir=mimir, kode=/abs/k=nav-wiki+kode-wiki", REPO);
    expect(reg).toEqual([
      { name: "mimir", root: "/repo/mimir", source: "extra", collections: ["mimir"] },
      { name: "kode", root: "/abs/k", source: "extra", collections: ["nav-wiki", "kode-wiki"] },
    ]);
  });

  test("WIKI_EXTRA 2-segment (no collections) still works — no collections key", () => {
    const reg = buildWikiRegistry([], "mimir=../mimir", REPO);
    expect(reg).toEqual([{ name: "mimir", root: "/repo/mimir", source: "extra" }]);
    expect(reg[0]!.collections).toBeUndefined();
  });

  test("WIKI_EXTRA 3-segment trims whitespace inside the collection list", () => {
    const reg = buildWikiRegistry([], "  kode = /abs/k = a + b ", REPO);
    expect(reg).toEqual([{ name: "kode", root: "/abs/k", source: "extra", collections: ["a", "b"] }]);
  });

  test("WIKI_EXTRA empty third segment (trailing =) yields no collections", () => {
    const reg = buildWikiRegistry([], "kode=/abs/k=", REPO);
    expect(reg).toEqual([{ name: "kode", root: "/abs/k", source: "extra" }]);
  });

  test("WIKI_EXTRA 2-segment: '=' inside the path round-trips (tail isn't a collection charset)", () => {
    // Tail after the last '=' is "b/c" — has a '/', so it's a path, not collections.
    const reg = buildWikiRegistry([], "weird=/abs/a=b/c", REPO);
    expect(reg).toEqual([{ name: "weird", root: "/abs/a=b/c", source: "extra" }]);
    expect(reg[0]!.collections).toBeUndefined();
  });

  test("WIKI_EXTRA 3-segment: path itself contains '=' AND a trailing collection list", () => {
    const reg = buildWikiRegistry([], "weird=/abs/a=b=nav-wiki+kode", REPO);
    expect(reg).toEqual([
      { name: "weird", root: "/abs/a=b", source: "extra", collections: ["nav-wiki", "kode"] },
    ]);
  });

  test("WIKI_EXTRA 3-segment normal: name before first '=', path, +-separated collections", () => {
    const reg = buildWikiRegistry([], "mimir=../mimir=mimir+notes", REPO);
    expect(reg).toEqual([
      { name: "mimir", root: "/repo/mimir", source: "extra", collections: ["mimir", "notes"] },
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
