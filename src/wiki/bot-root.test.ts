import { test, expect, describe } from "bun:test";
import { resolveBotWikiRoot, listWikiBots } from "./bot-root.ts";
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
