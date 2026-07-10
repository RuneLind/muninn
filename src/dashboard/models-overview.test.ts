import { test, expect, beforeEach, afterEach } from "bun:test";
import type { BotConfig } from "../bots/config.ts";
import type { Watcher } from "../types.ts";
import {
  assembleModelsOverview,
  _internalsForTest,
  type ModelsOverviewDeps,
  type HaikuUsageRow,
  type ChatModelRow,
} from "./models-overview.ts";

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
}): ModelsOverviewDeps {
  return {
    discoverBots: over.discoverBots ?? (() => over.bots ?? []),
    getWatchers: over.getWatchers ?? (async () => over.watchers ?? []),
    getHaikuUsage: over.getHaikuUsage ?? (async () => over.haiku ?? []),
    getChatModels: over.getChatModels ?? (async () => over.chat ?? []),
  };
}

// Isolate env knobs the assembly reads.
const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.SUMMARIZER_BOT;
  delete process.env.RESEARCH_BOT;
  delete process.env.HAIKU_BACKEND;
  delete process.env.HAIKU_DIRECT_ENABLED;
  delete process.env.CLAUDE_MODEL;
});
afterEach(() => {
  process.env = { ...SAVED };
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
  // What's-new digest rides the research bot.
  expect(digest.bot).toBe("jarvis");
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
  expect(o.roles.find((r) => r.role.startsWith("What's-new"))!.origin).toBe("env");
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
  ];
  const o = await assembleModelsOverview("jarvis", deps({ bots: [bot("jarvis")], watchers }));
  const x = o.pipeline.find((p) => p.job.startsWith("Watcher: X Highlights"))!;
  const email = o.pipeline.find((p) => p.job.startsWith("Watcher: Email"))!;
  const linter = o.pipeline.find((p) => p.job.startsWith("Watcher: Wiki Linter"))!;

  expect(x.model).toEqual({ value: "claude-sonnet-4-6", origin: "config" });
  expect(email.model.origin).toBe("default"); // Haiku default
  expect(email.model.value).toContain("haiku");
  expect(linter.model.value).toBe("—"); // report-only, no AI
  expect(linter.model.origin).toBe("none");
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
