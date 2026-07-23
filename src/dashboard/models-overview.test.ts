import { test, expect, beforeEach, afterEach } from "bun:test";
import type { BotConfig } from "../bots/config.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";
import type { Watcher } from "../types.ts";
import {
  assembleModelsOverview,
  _internalsForTest,
  type ModelsOverviewDeps,
  type HaikuUsageRow,
  type ChatModelRow,
} from "./models-overview.ts";
import { _resetSnapshotForTests } from "../db/role-overrides.ts";

/** Minimal BotConfig factory — only the fields the overview reads. */
function bot(name: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    name,
    dir: `/bots/${name}`,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    ...over,
  } as BotConfig;
}

function watcher(name: string, type: Watcher["type"], config: Record<string, unknown> = {}, botName = "jarvis"): Watcher {
  return {
    id: `w-${name}`,
    userId: "u1",
    botName,
    name,
    type,
    config,
    intervalMs: 3600_000,
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

function deps(over: Partial<ModelsOverviewDeps> & {
  bots?: BotConfig[];
  watchers?: Watcher[];
  haiku?: HaikuUsageRow[];
  chat?: ChatModelRow[];
  wikiRegistry?: WikiRegistryEntry[];
}): ModelsOverviewDeps {
  return {
    discoverBots: over.discoverBots ?? (() => over.bots ?? []),
    getWatchers: over.getWatchers ?? (async () => over.watchers ?? []),
    getHaikuUsage: over.getHaikuUsage ?? (async () => over.haiku ?? []),
    getChatModels: over.getChatModels ?? (async () => over.chat ?? []),
    getWikiRegistry: over.getWikiRegistry ?? (() => over.wikiRegistry ?? []),
  };
}

/** Minimal WikiRegistryEntry factory. */
function wiki(
  name: string,
  source: WikiRegistryEntry["source"] = "bot",
  synthesisBot?: string,
): WikiRegistryEntry {
  return { name, root: `/wikis/${name}`, source, ...(synthesisBot ? { synthesisBot } : {}) };
}

// Isolate env knobs the assembly reads.
const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.SUMMARIZER_BOT;
  delete process.env.RESEARCH_BOT;
  delete process.env.HAIKU_BACKEND;
  delete process.env.HAIKU_DIRECT_ENABLED;
  delete process.env.CLAUDE_MODEL;
  _resetSnapshotForTests();
});
afterEach(() => {
  process.env = { ...SAVED };
  _resetSnapshotForTests();
});

test("bot row: connector + model default origins when unset", async () => {
  const o = await assembleModelsOverview("jarvis", deps({ bots: [bot("jarvis")] }));
  const j = o.bots[0]!;
  expect(j.connector).toEqual({ value: "claude-cli", origin: "default" });
  expect(j.model.value).toBe("sonnet"); // CLAUDE_MODEL default
  expect(j.model.origin).toBe("default");
  // No connector, no haikuBackend, no env ⇒ cli floor, default origin.
  expect(j.haikuBackend.value).toBe("cli");
  expect(j.haikuBackend.origin).toBe("default");
});

test("bot row: config origins when set", async () => {
  const o = await assembleModelsOverview(
    "melosys",
    deps({ bots: [bot("melosys", { connector: "copilot-sdk", model: "claude-sonnet-4-6", thinkingMaxTokens: 16000 })] }),
  );
  const m = o.bots[0]!;
  expect(m.connector).toEqual({ value: "copilot-sdk", origin: "config" });
  expect(m.model).toEqual({ value: "claude-sonnet-4-6", origin: "config" });
  expect(m.thinkingMaxTokens).toBe(16000);
});

test("haikuBackend resolution origins mirror resolveBackendWithReason order", async () => {
  // 1. copilot-sdk connector ⇒ derived
  let o = await assembleModelsOverview("b", deps({ bots: [bot("b", { connector: "copilot-sdk" })] }));
  expect(o.bots[0]!.haikuBackend).toEqual({ value: "copilot", origin: "derived" });

  // 2. explicit per-bot haikuBackend ⇒ config
  o = await assembleModelsOverview("b", deps({ bots: [bot("b", { haikuBackend: "anthropic" })] }));
  expect(o.bots[0]!.haikuBackend).toEqual({ value: "anthropic", origin: "config" });

  // 3. HAIKU_BACKEND env trumps per-bot config ⇒ env
  process.env.HAIKU_BACKEND = "cli";
  o = await assembleModelsOverview("b", deps({ bots: [bot("b", { haikuBackend: "anthropic", connector: "copilot-sdk" })] }));
  expect(o.bots[0]!.haikuBackend).toEqual({ value: "cli", origin: "env" });
  delete process.env.HAIKU_BACKEND;

  // 4. legacy HAIKU_DIRECT_ENABLED ⇒ anthropic / legacy
  process.env.HAIKU_DIRECT_ENABLED = "1";
  o = await assembleModelsOverview("b", deps({ bots: [bot("b")] }));
  expect(o.bots[0]!.haikuBackend).toEqual({ value: "anthropic", origin: "legacy" });
});

test("research bot skips opus (non-opus rule); summarizer takes first discovered", async () => {
  const bots = [bot("capra", { model: "opus" }), bot("jarvis"), bot("melosys", { connector: "copilot-sdk" })];
  const o = await assembleModelsOverview("jarvis", deps({ bots }));
  const summarizer = o.roles.find((r) => r.role.startsWith("Summarizer"))!;
  const research = o.roles.find((r) => r.role.startsWith("Research"))!;
  const digest = o.roles.find((r) => r.role.startsWith("What's-new"))!;

  // Summarizer = first discovered (capra), no env ⇒ default.
  expect(summarizer.bot).toBe("capra");
  expect(summarizer.origin).toBe("default");

  // Research = first NON-opus (jarvis), not capra — a derivation, not a bare default.
  expect(research.bot).toBe("jarvis");
  expect(research.origin).toBe("derived");
  // What's-new digest now routes per-wiki — no single bot, points at Wiki synthesis.
  expect(digest.bot).toBeNull();
  expect(digest.origin).toBe("derived");
  expect(digest.note).toContain("Wiki synthesis");
});

test("summarizer TikTok constraint chip flips red for a non-CLI connector", async () => {
  // First-discovered summarizer is copilot-sdk ⇒ no --add-dir ⇒ constraint violated.
  const o = await assembleModelsOverview("melosys", deps({ bots: [bot("melosys", { connector: "copilot-sdk" })] }));
  const summarizer = o.roles.find((r) => r.role.startsWith("Summarizer"))!;
  expect(summarizer.noteOk).toBe(false);
  expect(summarizer.note).toContain("blocked");

  // A claude-cli summarizer satisfies it.
  const o2 = await assembleModelsOverview("jarvis", deps({ bots: [bot("jarvis")] }));
  expect(o2.roles.find((r) => r.role.startsWith("Summarizer"))!.noteOk).toBe(true);
});

test("env overrides mark role origin as env", async () => {
  process.env.SUMMARIZER_BOT = "jarvis";
  process.env.RESEARCH_BOT = "jarvis";
  const o = await assembleModelsOverview("jarvis", deps({ bots: [bot("jarvis"), bot("capra", { model: "opus" })] }));
  expect(o.roles.find((r) => r.role.startsWith("Summarizer"))!.origin).toBe("env");
  expect(o.roles.find((r) => r.role.startsWith("Research"))!.origin).toBe("env");
  // The digest row no longer tracks the research bot — it's a static per-wiki pointer.
  expect(o.roles.find((r) => r.role.startsWith("What's-new"))!.origin).toBe("derived");
});

test("DB override marks role origin as override and beats env", async () => {
  process.env.SUMMARIZER_BOT = "jarvis";
  process.env.RESEARCH_BOT = "jarvis";
  _resetSnapshotForTests({ SUMMARIZER_BOT: "capra", RESEARCH_BOT: "capra", HAIKU_BACKEND: "anthropic" });
  const o = await assembleModelsOverview(
    "jarvis",
    deps({ bots: [bot("jarvis"), bot("capra", { model: "opus" })] }),
  );
  const summarizer = o.roles.find((r) => r.role.startsWith("Summarizer"))!;
  const research = o.roles.find((r) => r.role.startsWith("Research"))!;
  const haiku = o.roles.find((r) => r.role.startsWith("Global Haiku"))!;
  expect(summarizer.bot).toBe("capra");
  expect(summarizer.origin).toBe("override");
  expect(summarizer.overrideKey).toBe("SUMMARIZER_BOT");
  expect(research.bot).toBe("capra");
  expect(research.origin).toBe("override");
  expect(haiku.origin).toBe("override");
  expect(haiku.bot).toBe("anthropic");
  // Per-bot haiku backend column also reflects the override.
  expect(o.bots.find((b) => b.name === "jarvis")!.haikuBackend).toEqual({ value: "anthropic", origin: "override" });
});

test("env var naming a nonexistent bot is NOT labeled env — resolver fallback is surfaced", async () => {
  process.env.SUMMARIZER_BOT = "typo-bot";
  process.env.RESEARCH_BOT = "typo-bot";
  const o = await assembleModelsOverview("jarvis", deps({ bots: [bot("jarvis")] }));
  const summarizer = o.roles.find((r) => r.role.startsWith("Summarizer"))!;
  const research = o.roles.find((r) => r.role.startsWith("Research"))!;
  // The resolvers ignored the env var and fell back to jarvis.
  expect(summarizer.bot).toBe("jarvis");
  expect(summarizer.origin).toBe("default");
  expect(summarizer.noteOk).toBe(false);
  expect(summarizer.note).toContain("matches no bot");
  expect(research.origin).toBe("derived");
  expect(research.noteOk).toBe(false);
  expect(research.note).toContain("matches no bot");
  expect(o.roles.find((r) => r.role.startsWith("What's-new"))!.origin).toBe("derived");
});

test("watcher gate model: per-watcher config.model, else Haiku default", async () => {
  const watchers = [
    watcher("X Highlights", "x", { model: "claude-sonnet-4-6" }),
    watcher("Email", "email", {}),
    watcher("Wiki Linter", "wiki-linter", {}),
    watcher("Wiki Committer", "wiki-committer", {}),
  ];
  const o = await assembleModelsOverview("jarvis", deps({ bots: [bot("jarvis")], watchers }));
  const x = o.pipeline.find((p) => p.job.startsWith("Watcher: X Highlights"))!;
  const email = o.pipeline.find((p) => p.job.startsWith("Watcher: Email"))!;
  const linter = o.pipeline.find((p) => p.job.startsWith("Watcher: Wiki Linter"))!;
  const committer = o.pipeline.find((p) => p.job.startsWith("Watcher: Wiki Committer"))!;

  expect(x.model).toEqual({ value: "claude-sonnet-4-6", origin: "config" });
  expect(email.model.origin).toBe("default"); // Haiku default
  expect(email.model.value).toContain("haiku");
  expect(linter.model.value).toBe("—"); // report-only, no AI
  expect(linter.model.origin).toBe("none");
  // The sweeper is a no-AI watcher, not a Haiku CLI job — no model, dedicated note.
  expect(committer.model).toEqual({ value: "—", origin: "none" });
  expect(committer.backend).toBe("none");
  expect(committer.note).toBe("commit sweeper (no AI)");
});

test("actually-used column maps haiku_usage by source+bot and traces by bot", async () => {
  const haiku: HaikuUsageRow[] = [
    { source: "knowledge-decompose", botName: "jarvis", model: "claude-haiku-4-5-20251001" },
    { source: "memory", botName: "jarvis", model: "claude-haiku-4.5" },
    { source: "watcher-x", botName: "jarvis", model: "claude-sonnet-4-6" },
  ];
  const chat: ChatModelRow[] = [{ botName: "jarvis", model: "claude-sonnet-4-6" }];
  const o = await assembleModelsOverview(
    "jarvis",
    deps({ bots: [bot("jarvis")], watchers: [watcher("X", "x", {})], haiku, chat }),
  );

  // Bots table: chat + all haiku models aggregated for the bot.
  const j = o.bots[0]!;
  expect(j.usedChatModels).toEqual(["claude-sonnet-4-6"]);
  expect(j.usedHaikuModels).toContain("claude-haiku-4.5");
  expect(j.usedHaikuModels).toContain("claude-sonnet-4-6");

  // Pipeline: decomposer row shows its source's models; memory row shows the copilot id.
  const decomp = o.pipeline.find((p) => p.job.startsWith("research_knowledge"))!;
  expect(decomp.used).toEqual(["claude-haiku-4-5-20251001"]);
  const xw = o.pipeline.find((p) => p.job.startsWith("Watcher: X"))!;
  expect(xw.used).toEqual(["claude-sonnet-4-6"]);

  // Nothing recorded ⇒ empty array (rendered as "—").
  const goals = o.pipeline.find((p) => p.job.startsWith("Goal detector"))!;
  expect(goals.used).toEqual([]);
});

test("embeddings + gardener draft cap rows are present and fixed", async () => {
  const o = await assembleModelsOverview("jarvis", deps({ bots: [bot("jarvis", { model: "claude-sonnet-4-6" })] }));
  const emb = o.pipeline.find((p) => p.job.startsWith("Embeddings"))!;
  expect(emb.model.value).toBe(_internalsForTest().EMBEDDINGS_MODEL);
  expect(emb.model.origin).toBe("fixed");

  const draft = o.pipeline.find((p) => p.job.startsWith("Gardener drafts"))!;
  expect(draft.model.value).toBe("claude-sonnet-4-6"); // bot model
  expect(draft.note).toContain("8,000");
});

test("wiki synthesis: owner-fast → owner, opus owner + standalone → fallback", async () => {
  const bots = [
    bot("capra", { model: "opus", connector: "copilot-sdk" }),
    bot("jarvis", { connector: "claude-sdk" }),
    bot("melosys", { connector: "copilot-sdk" }),
  ];
  const wikiRegistry = [
    wiki("jarvis", "bot"), // fast owner ⇒ owner
    wiki("melosys", "bot"), // fast owner ⇒ owner
    wiki("capra", "bot"), // opus owner ⇒ fallback (research bot)
    wiki("mimir", "extra"), // standalone ⇒ fallback
  ];
  const o = await assembleModelsOverview("jarvis", deps({ bots, wikiRegistry }));
  const rows = Object.fromEntries(o.wikiSynthesis.map((w) => [w.wiki, w]));

  expect(rows.jarvis).toMatchObject({ bot: "jarvis", origin: "owner", connector: "claude-sdk" });
  expect(rows.melosys).toMatchObject({ bot: "melosys", origin: "owner", connector: "copilot-sdk" });
  // Research fallback bot = first non-opus discovered = jarvis.
  expect(rows.capra).toMatchObject({ bot: "jarvis", origin: "fallback" });
  expect(rows.mimir).toMatchObject({ bot: "jarvis", origin: "fallback", source: "extra" });
});

test("wiki synthesis: RESEARCH_BOT override steers the fallback branch", async () => {
  process.env.RESEARCH_BOT = "melosys";
  const bots = [bot("jarvis"), bot("melosys", { connector: "copilot-sdk" })];
  const o = await assembleModelsOverview("jarvis", deps({ bots, wikiRegistry: [wiki("mimir", "extra")] }));
  expect(o.wikiSynthesis[0]).toMatchObject({ wiki: "mimir", bot: "melosys", origin: "fallback" });
});

test("wiki synthesis: explicit pin → pinned chip (beats owner-gate + fallback, no ignoredPin)", async () => {
  const bots = [
    bot("capra", { model: "opus", connector: "copilot-sdk" }),
    bot("jarvis", { connector: "claude-sdk" }),
    bot("melosys", { connector: "copilot-sdk" }),
  ];
  const wikiRegistry = [
    wiki("capra", "bot", "capra"), // opus owner pinned to itself ⇒ pinned (bypasses gate)
    wiki("melosys-kode-wiki", "extra", "melosys"), // standalone pinned ⇒ pinned, not fallback
  ];
  const o = await assembleModelsOverview("jarvis", deps({ bots, wikiRegistry }));
  const rows = Object.fromEntries(o.wikiSynthesis.map((w) => [w.wiki, w]));
  expect(rows.capra).toMatchObject({ bot: "capra", origin: "pinned", connector: "copilot-sdk", model: "opus" });
  expect(rows.capra!.ignoredPin).toBeUndefined();
  expect(rows["melosys-kode-wiki"]).toMatchObject({ bot: "melosys", origin: "pinned", source: "extra" });
});

test("wiki synthesis: pin matching no bot → ignoredPin note + owner/fallback routing", async () => {
  const bots = [bot("jarvis", { connector: "claude-sdk" }), bot("melosys", { connector: "copilot-sdk" })];
  const wikiRegistry = [
    wiki("jarvis", "bot", "ghost"), // bad pin on owner wiki ⇒ falls through to owner
    wiki("mimir", "extra", "ghost"), // bad pin on standalone ⇒ falls through to fallback
  ];
  const o = await assembleModelsOverview("jarvis", deps({ bots, wikiRegistry }));
  const rows = Object.fromEntries(o.wikiSynthesis.map((w) => [w.wiki, w]));
  expect(rows.jarvis).toMatchObject({ bot: "jarvis", origin: "owner", ignoredPin: "ghost" });
  expect(rows.mimir).toMatchObject({ bot: "jarvis", origin: "fallback", ignoredPin: "ghost" });
});

test("mismatch field: substring-tolerant, offending models listed", async () => {
  const { computeModelMismatch } = _internalsForTest();
  // Exact match ⇒ no mismatch.
  expect(computeModelMismatch("claude-sonnet-4-6", ["claude-sonnet-4-6"])).toEqual([]);
  // Bidirectional substring tolerance (id-shape drift): a date-suffixed id whose
  // prefix is the configured short id ⇒ no mismatch (used contains configured).
  expect(computeModelMismatch("claude-sonnet-4-6", ["claude-sonnet-4-6-20250219"])).toEqual([]);
  // …and the reverse (configured contains used).
  expect(computeModelMismatch("claude-haiku-4-5-full", ["claude-haiku-4-5"])).toEqual([]);
  // A genuinely different model ⇒ flagged.
  expect(computeModelMismatch("claude-sonnet-5", ["claude-opus-4", "claude-sonnet-5"])).toEqual(["claude-opus-4"]);
});

test("bot row carries mismatch + mismatchModels from the pure predicate", async () => {
  const chat: ChatModelRow[] = [
    { botName: "jarvis", model: "claude-sonnet-5" }, // matches configured
    { botName: "jarvis", model: "claude-opus-4" }, // diverges
  ];
  const o = await assembleModelsOverview(
    "jarvis",
    deps({ bots: [bot("jarvis", { model: "claude-sonnet-5" })], chat }),
  );
  const j = o.bots[0]!;
  expect(j.mismatch).toBe(true);
  expect(j.mismatchModels).toEqual(["claude-opus-4"]);

  // A bot whose only used model matches ⇒ no mismatch.
  const o2 = await assembleModelsOverview(
    "jarvis",
    deps({ bots: [bot("jarvis", { model: "claude-sonnet-5" })], chat: [{ botName: "jarvis", model: "claude-sonnet-5" }] }),
  );
  expect(o2.bots[0]!.mismatch).toBe(false);
  expect(o2.bots[0]!.mismatchModels).toEqual([]);
});

test("why-chain: exactly one winning row, mirrors resolveBackendWithReason", async () => {
  // 1. Plain claude-cli bot ⇒ floor folds into the connector row.
  let o = await assembleModelsOverview("jarvis", deps({ bots: [bot("jarvis")] }));
  let chain = o.bots[0]!.chain;
  expect(chain.filter((r) => r.wins)).toHaveLength(1);
  let winner = chain.find((r) => r.wins)!;
  expect(winner.source).toBe("connector");
  expect(winner.value).toBe("cli");
  // Legacy row absent when the flag is unset.
  expect(chain.some((r) => r.source === "legacy")).toBe(false);

  // 2. copilot-sdk bot ⇒ connector row wins with copilot.
  o = await assembleModelsOverview("b", deps({ bots: [bot("b", { connector: "copilot-sdk" })] }));
  winner = o.bots[0]!.chain.find((r) => r.wins)!;
  expect(winner.source).toBe("connector");
  expect(winner.value).toBe("copilot");

  // 3. per-bot config wins ⇒ config row.
  o = await assembleModelsOverview("b", deps({ bots: [bot("b", { haikuBackend: "anthropic" })] }));
  winner = o.bots[0]!.chain.find((r) => r.wins)!;
  expect(winner.source).toBe("config");
  expect(winner.value).toBe("anthropic");

  // 4. env wins + legacy row rendered when the flag is set.
  process.env.HAIKU_BACKEND = "cli";
  process.env.HAIKU_DIRECT_ENABLED = "1";
  o = await assembleModelsOverview("b", deps({ bots: [bot("b", { connector: "copilot-sdk" })] }));
  chain = o.bots[0]!.chain;
  expect(chain.find((r) => r.wins)!.source).toBe("env");
  expect(chain.some((r) => r.source === "legacy")).toBe(true);
});

test("degraded sources are collected, never thrown", async () => {
  const o = await assembleModelsOverview(
    "jarvis",
    deps({
      bots: [bot("jarvis")],
      getWatchers: async () => { throw new Error("db down"); },
      getHaikuUsage: async () => { throw new Error("no usage"); },
    }),
  );
  expect(o.errors).toBeDefined();
  expect(o.errors!.join(" ")).toContain("db down");
  expect(o.errors!.join(" ")).toContain("no usage");
  // Still renders the bot row.
  expect(o.bots).toHaveLength(1);
});
