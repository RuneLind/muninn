import { test, expect, describe } from "bun:test";
import { resolveBotWikiRoot, listWikiBots, defaultWikiBot, resolveWikiRequest } from "./bot-root.ts";
import type { BotConfig } from "../bots/config.ts";

/** Minimal BotConfig stubs — only the fields the resolver reads. */
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

describe("resolveBotWikiRoot", () => {
  test("no/blank bot → default (no explicit root)", () => {
    expect(resolveBotWikiRoot(BOTS, undefined)).toEqual({});
    expect(resolveBotWikiRoot(BOTS, "")).toEqual({});
    expect(resolveBotWikiRoot(BOTS, "  ")).toEqual({});
  });

  test("known bot with wikiDir → its root", () => {
    expect(resolveBotWikiRoot(BOTS, "melosys")).toEqual({ root: "/abs/huginn-nav/wiki" });
  });

  test("bot match is case-insensitive and trims whitespace", () => {
    expect(resolveBotWikiRoot(BOTS, "  JARVIS ")).toEqual({ root: "/abs/huginn-jarvis/data/wiki" });
  });

  test("unknown bot → unknownBot", () => {
    expect(resolveBotWikiRoot(BOTS, "ghost")).toEqual({ unknownBot: true });
  });

  test("known bot without a wikiDir → unknownBot (empty state, not the default wiki)", () => {
    expect(resolveBotWikiRoot(BOTS, "nowiki")).toEqual({ unknownBot: true });
  });
});

describe("listWikiBots", () => {
  test("lists only bots that expose a wiki", () => {
    expect(listWikiBots(BOTS)).toEqual(["jarvis", "melosys"]);
  });
});

describe("defaultWikiBot", () => {
  test("prefers jarvis when it exposes a wiki", () => {
    expect(defaultWikiBot(BOTS)).toBe("jarvis");
  });

  test("matches jarvis case-insensitively", () => {
    expect(defaultWikiBot([bot("Jarvis", "/w"), bot("melosys", "/m")])).toBe("Jarvis");
  });

  test("falls back to the first wiki bot when jarvis has no wiki", () => {
    expect(defaultWikiBot([bot("jarvis"), bot("melosys", "/m"), bot("capra", "/c")])).toBe("melosys");
  });

  test("undefined when no bot exposes a wiki", () => {
    expect(defaultWikiBot([bot("nowiki"), bot("other")])).toBeUndefined();
  });
});

describe("resolveWikiRequest", () => {
  test("known bot → canonical name (case-corrected), no env override", () => {
    expect(resolveWikiRequest(BOTS, "MELOSYS", undefined)).toEqual({ bot: "melosys", envOverride: false });
    expect(resolveWikiRequest(BOTS, "  Jarvis ", undefined)).toEqual({ bot: "jarvis", envOverride: false });
  });

  test("unknown/no-wikiDir bot keeps the raw name so the client hits the empty state", () => {
    expect(resolveWikiRequest(BOTS, "ghost", undefined)).toEqual({ bot: "ghost", envOverride: false });
    expect(resolveWikiRequest(BOTS, "nowiki", undefined)).toEqual({ bot: "nowiki", envOverride: false });
  });

  test("bare /wiki resolves the default wiki bot (same path as ?bot=<default>)", () => {
    expect(resolveWikiRequest(BOTS, undefined, undefined)).toEqual({ bot: "jarvis", envOverride: false });
    expect(resolveWikiRequest(BOTS, "", undefined)).toEqual({ bot: "jarvis", envOverride: false });
  });

  test("bare /wiki with WIKI_DIR set → env override, no bot claimed", () => {
    expect(resolveWikiRequest(BOTS, undefined, "/some/wiki")).toEqual({ bot: "", envOverride: true });
    // whitespace-only env is treated as unset
    expect(resolveWikiRequest(BOTS, undefined, "  ")).toEqual({ bot: "jarvis", envOverride: false });
  });

  test("an explicit ?bot= wins over the WIKI_DIR override", () => {
    expect(resolveWikiRequest(BOTS, "melosys", "/some/wiki")).toEqual({ bot: "melosys", envOverride: false });
  });

  test("no bot exposes a wiki → empty bot, store's own fallback serves content", () => {
    expect(resolveWikiRequest([bot("nowiki")], undefined, undefined)).toEqual({ bot: "", envOverride: false });
  });
});
