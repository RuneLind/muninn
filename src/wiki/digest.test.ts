import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { Tracer } from "../tracing/index.ts";
import { agentStatus } from "../observability/agent-status.ts";
import {
  parseLogEntries,
  selectRecentEntries,
  renderEntriesBlock,
  markPageMentions,
  readLogMtimeMs,
  newestLogEntryDate,
  generateWikiDigest,
  DIGEST_MAX_BYTES,
  type LogEntry,
} from "./digest.ts";
import { buildWikiIndex, type WikiIndex, type WikiPageMeta } from "./store.ts";

const SAMPLE_LOG = [
  "# Log",
  "",
  "Chronological, append-only.",
  "",
  "---",
  "",
  "## [2026-05-01] note | Wiki initialized",
  "",
  "Bootstrapped the wiki.",
  "",
  "## [2026-05-02] ingest | Bootstrap from README",
  "",
  "Wrote 17 pages across muninn and huginn.",
  "Second body line.",
  "",
  "## [2026-05-03] Header without a kind pipe",
  "",
  "This entry omits the ` | `.",
].join("\n");

describe("parseLogEntries", () => {
  test("splits entries, ignores the intro, and captures date/kind/title/body", () => {
    const entries = parseLogEntries(SAMPLE_LOG);
    expect(entries.length).toBe(3);
    expect(entries[0]).toMatchObject({ date: "2026-05-01", kind: "note", title: "Wiki initialized" });
    expect(entries[0]!.body).toBe("Bootstrapped the wiki.");
    expect(entries[1]!.body).toBe("Wrote 17 pages across muninn and huginn.\nSecond body line.");
    // Header without a ` | ` → empty kind, whole remainder is the title.
    expect(entries[2]).toMatchObject({ date: "2026-05-03", kind: "", title: "Header without a kind pipe" });
  });

  test("returns [] when there are no entry headers", () => {
    expect(parseLogEntries("# Log\n\nJust an intro, no entries.")).toEqual([]);
  });
});

describe("selectRecentEntries", () => {
  function entry(date: string, body = "x"): LogEntry {
    return { date, kind: "note", title: "t " + date, body };
  }

  test("keeps entries within the day window, anchored to the newest entry", () => {
    const entries = [
      entry("2026-01-01"),
      entry("2026-05-01"),
      entry("2026-05-10"),
      entry("2026-05-14"),
    ];
    const selected = selectRecentEntries(entries, { windowDays: 14 });
    // Anchor = 2026-05-14; cutoff = 2026-04-30 → drops the Jan entry only.
    expect(selected.map((e) => e.date)).toEqual(["2026-05-01", "2026-05-10", "2026-05-14"]);
  });

  test("caps entry count to the newest N, dropping the oldest", () => {
    // 40 unique ascending dates (2026-04-01 … 2026-05-10, all in the past).
    const entries = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);
      return entry(d);
    });
    const selected = selectRecentEntries(entries, { windowDays: 3650, maxEntries: 30 });
    expect(selected.length).toBe(30);
    // Oldest 10 dropped: the newest 30 survive, still oldest→newest.
    expect(selected[0]!.date).toBe(entries[10]!.date);
    expect(selected[selected.length - 1]!.date).toBe(entries[39]!.date);
  });

  test("is order-independent: newest-first input yields the same oldest→newest window", () => {
    const asc = [entry("2026-05-01"), entry("2026-05-02"), entry("2026-05-03")];
    const desc = [...asc].reverse(); // newest-first, as bot wikis prepend
    const fromAsc = selectRecentEntries(asc, { windowDays: 30 }).map((e) => e.date);
    const fromDesc = selectRecentEntries(desc, { windowDays: 30 }).map((e) => e.date);
    expect(fromAsc).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
    expect(fromDesc).toEqual(fromAsc);
  });

  test("a future-dated typo does not collapse the window or leak into the range", () => {
    const entries = [
      entry("2026-05-01"),
      entry("2099-01-01"), // typo'd year — far future
      entry("2026-05-12"),
      entry("2026-05-14"),
    ];
    // now() pinned so 2099 is unambiguously future; anchor = 2026-05-14.
    const now = () => Date.parse("2026-05-20T00:00:00Z");
    const selected = selectRecentEntries(entries, { windowDays: 14, now });
    expect(selected.map((e) => e.date)).toEqual(["2026-05-01", "2026-05-12", "2026-05-14"]);
  });

  test("all-future entries fall back to the max date as the anchor", () => {
    const entries = [entry("2099-01-01"), entry("2099-01-10"), entry("2099-01-15")];
    const now = () => Date.parse("2026-05-20T00:00:00Z");
    const selected = selectRecentEntries(entries, { windowDays: 14, now });
    // Anchor falls back to 2099-01-15; window keeps the last fortnight of it.
    expect(selected.map((e) => e.date)).toEqual(["2099-01-01", "2099-01-10", "2099-01-15"]);
  });

  test("skips invalid calendar dates (would otherwise crash shiftDate)", () => {
    const entries = [
      entry("2026-13-45"), // impossible date — parse regex matches, calendar rejects
      entry("2026-05-10"),
      entry("2026-05-11"),
    ];
    const selected = selectRecentEntries(entries, { windowDays: 30 });
    expect(selected.map((e) => e.date)).toEqual(["2026-05-10", "2026-05-11"]);
  });

  test("truncates a lone oversized entry rather than shipping it whole", () => {
    const huge = "z".repeat(20_000);
    const selected = selectRecentEntries([entry("2026-05-12", huge)], { windowDays: 30, maxBytes: 8000 });
    expect(selected.length).toBe(1);
    const rendered = renderEntriesBlock(selected);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(8000);
    expect(rendered).toContain("truncated");
  });

  test("trims oldest entries until under the byte cap", () => {
    const big = "y".repeat(5000);
    const entries = [entry("2026-05-10", big), entry("2026-05-11", big), entry("2026-05-12", big)];
    const selected = selectRecentEntries(entries, { windowDays: 30, maxBytes: 8000 });
    // Each entry renders to >5000 bytes, so only the newest survives the 8 KB cap.
    expect(selected.map((e) => e.date)).toEqual(["2026-05-12"]);
    expect(Buffer.byteLength(renderEntriesBlock(selected), "utf8")).toBeLessThanOrEqual(8000);
  });

  test("empty input yields empty output", () => {
    expect(selectRecentEntries([])).toEqual([]);
  });
});

describe("markPageMentions", () => {
  // Minimal resolver: knows two canonical pages, case-insensitive.
  const pages: Record<string, string> = {
    "harness engineering": "Harness Engineering",
    "knowledge-graph": "knowledge-graph",
  };
  const resolve = (t: string): WikiPageMeta | undefined => {
    const name = pages[t.trim().toLowerCase()];
    return name ? ({ name } as WikiPageMeta) : undefined;
  };

  test("canonicalizes resolvable [[wikilinks]] and leaves unresolvable ones", () => {
    const out = markPageMentions("See [[harness engineering]] and [[Nonexistent]].", resolve);
    expect(out).toBe("See [[Harness Engineering]] and [[Nonexistent]].");
  });

  test("links backticked and quoted page names that resolve", () => {
    expect(markPageMentions("Updated `knowledge-graph` today.", resolve)).toBe(
      "Updated [[knowledge-graph]] today.",
    );
    expect(markPageMentions('The "Harness Engineering" page grew.', resolve)).toBe(
      "The [[Harness Engineering]] page grew.",
    );
  });

  test("leaves unresolvable backtick/quote mentions untouched", () => {
    const input = "Ran `bun test` and edited \"some prose\".";
    expect(markPageMentions(input, resolve)).toBe(input);
  });

  test("does not rewrite mentions inside a fenced code block", () => {
    const input =
      "See `knowledge-graph`.\n\n```\nconst knowledge-graph = load(`knowledge-graph`);\n```\n\nAlso `knowledge-graph`.";
    const out = markPageMentions(input, resolve);
    // Inline mentions outside the fence are linked…
    expect(out).toContain("See [[knowledge-graph]].");
    expect(out).toContain("Also [[knowledge-graph]].");
    // …but the fenced code ships verbatim (no wikilink rewriting inside).
    expect(out).toContain("const knowledge-graph = load(`knowledge-graph`);");
    expect(out).not.toContain("load([[knowledge-graph]])");
  });
});

describe("generateWikiDigest", () => {
  let root: string;
  let index: WikiIndex;
  const config = {} as Config;
  const bot = { name: "jarvis", dir: "/tmp/jarvis" } as BotConfig;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-digest-"));
    await Bun.write(path.join(root, "log.md"), SAMPLE_LOG);
    await Bun.write(
      path.join(root, "knowledge-graph.md"),
      "---\ntype: concept\ntitle: knowledge-graph\n---\n\nGraph body.",
    );
    index = await buildWikiIndex(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns null when the wiki has no log.md", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "wiki-nolog-"));
    try {
      const emptyIndex = await buildWikiIndex(empty);
      const digest = await generateWikiDigest(empty, emptyIndex, config, bot, {
        oneShot: async () => ({ result: "- x" }) as ClaudeExecResult,
      });
      expect(digest).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("summarizes entries and marks resolvable page mentions", async () => {
    let seenPrompt = "";
    let seenSystem = "";
    const digest = await generateWikiDigest(root, index, config, bot, {
      now: () => 1234,
      oneShot: async (prompt, _c, _b, opts) => {
        seenPrompt = prompt;
        seenSystem = opts?.systemPrompt ?? "";
        return { result: "- Grew the `knowledge-graph` page\n- Bootstrapped" } as ClaudeExecResult;
      },
    });
    expect(digest).not.toBeNull();
    expect(digest!.bullets).toContain("[[knowledge-graph]]");
    expect(digest!.generatedAt).toBe(1234);
    expect(digest!.entryCount).toBe(3);
    expect(digest!.fromDate).toBe("2026-05-01");
    expect(digest!.toDate).toBe("2026-05-03");
    expect(digest!.logMtimeMs).toBeGreaterThan(0);
    // The connector saw the entries block + a digest system prompt.
    expect(seenPrompt).toContain("Wiki initialized");
    expect(seenSystem.toLowerCase()).toContain("what's new");
  });

  test("returns null when the connector yields empty text", async () => {
    const digest = await generateWikiDigest(root, index, config, bot, {
      oneShot: async () => ({ result: "   " }) as ClaudeExecResult,
    });
    expect(digest).toBeNull();
  });
});

describe("readLogMtimeMs", () => {
  test("returns a number for an existing log.md and null when absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-mtime-"));
    try {
      expect(await readLogMtimeMs(root)).toBeNull();
      await Bun.write(path.join(root, "log.md"), "# Log");
      expect(await readLogMtimeMs(root)).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("newestLogEntryDate", () => {
  test("returns the max header date regardless of log ordering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-newest-"));
    try {
      // No log.md yet → null.
      expect(await newestLogEntryDate(root)).toBeNull();
      // Newest-first log (bot-wiki style): max is at the top.
      await Bun.write(
        path.join(root, "log.md"),
        [
          "# Log",
          "## [2026-07-08] update | latest",
          "body",
          "## [2026-07-01] note | older",
          "body",
        ].join("\n"),
      );
      expect(await newestLogEntryDate(root)).toBe("2026-07-08");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores invalid calendar dates and returns null with no headers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-newest2-"));
    try {
      await Bun.write(path.join(root, "log.md"), "# Log\n\nNo entry headers here.");
      expect(await newestLogEntryDate(root)).toBeNull();
      await Bun.write(
        path.join(root, "log.md"),
        "# Log\n## [2026-13-45] note | impossible\n## [2026-06-30] note | real",
      );
      expect(await newestLogEntryDate(root)).toBe("2026-06-30");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Guard: the exported byte cap stays a sane bound for the prompt block.
test("DIGEST_MAX_BYTES is a reasonable prompt bound", () => {
  expect(DIGEST_MAX_BYTES).toBeGreaterThan(1000);
  expect(DIGEST_MAX_BYTES).toBeLessThan(100_000);
});

// ── Observability ────────────────────────────────────────────────────────────
// The digest fires whenever a reader opens /wiki (cache miss). It used to leave
// nothing behind on either dashboard, so a slow or failing digest was invisible.

describe("generateWikiDigest — observability", () => {
  let root: string;
  let index: WikiIndex;
  const config = { tracingEnabled: true } as Config;
  const bot = { name: "jarvis", dir: "/tmp/jarvis" } as BotConfig;

  beforeEach(async () => {
    agentStatus.clearRequest(); // reset the singleton between cases
    root = await mkdtemp(path.join(tmpdir(), "wiki-digest-obs-"));
    await Bun.write(path.join(root, "log.md"), SAMPLE_LOG);
    index = await buildWikiIndex(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function recordingTracer() {
    const spans: Array<{ op: string; label?: string; attrs?: Record<string, unknown> }> = [];
    const tracer = {
      traceId: "digest-trace-1",
      start(label: string, attrs?: Record<string, unknown>) { spans.push({ op: "start", label, attrs }); return "s"; },
      end(label: string, attrs?: Record<string, unknown>) { spans.push({ op: "end", label, attrs }); return 1; },
      finish(status: "ok" | "error", attrs?: Record<string, unknown>) { spans.push({ op: "finish:" + status, attrs }); },
      addChildSpan() { return "c"; },
      addSubSpan() { return "s"; },
    } as unknown as Tracer;
    return { tracer, spans };
  }

  const okResult = { result: "- Grew a page", model: "claude-sonnet-5", inputTokens: 900, outputTokens: 80 } as ClaudeExecResult;

  test("traces the model call and settles a completed digest run on /agents", async () => {
    const { tracer, spans } = recordingTracer();
    await generateWikiDigest(root, index, config, bot, { tracer, oneShot: async () => okResult });

    const end = spans.find((s) => s.op === "end" && s.label === "claude")!;
    expect(end.attrs).toMatchObject({ model: "claude-sonnet-5", inputTokens: 900, outputTokens: 80 });
    expect(spans.some((s) => s.op === "finish:ok")).toBe(true);

    const runs = agentStatus.getRecentCompleted().filter((r) => r.kind === "digest");
    expect(runs).toHaveLength(1);
    expect(runs[0]!).toMatchObject({ botName: bot.name, outputTokens: 80, traceId: "digest-trace-1" });
    expect(agentStatus.getAll().some((r) => r.kind === "digest" && !r.completed)).toBe(false);
  });

  test("a failing digest stamps the trace error and settles the run (no leak)", async () => {
    const { tracer, spans } = recordingTracer();
    await expect(
      generateWikiDigest(root, index, config, bot, {
        tracer,
        oneShot: async () => { throw new Error("connector down"); },
      }),
    ).rejects.toThrow("connector down");

    expect(spans.find((s) => s.op === "finish:error")!.attrs).toMatchObject({ error: "connector down" });
    expect(agentStatus.getAll().some((r) => r.kind === "digest" && !r.completed)).toBe(false);
  });

  test("a wiki with no log.md registers NO run at all (the model is never called)", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "wiki-nolog-obs-"));
    try {
      const emptyIndex = await buildWikiIndex(empty);
      await generateWikiDigest(empty, emptyIndex, config, bot, { oneShot: async () => okResult });
      expect(agentStatus.getAll().filter((r) => r.kind === "digest")).toHaveLength(0);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
