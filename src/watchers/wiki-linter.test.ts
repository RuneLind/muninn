import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWikiLinter } from "./wiki-linter.ts";
import { __resetWikiCacheForTest } from "../wiki/store.ts";
import type { Watcher } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";

/**
 * Checker guards + alert shape. Uses real temp-dir wikis via the store (the
 * checker resolves `wikiDir` through `getWikiIndex`); the store cache is reset
 * between cases so each test sees its own tree.
 */
const watcher = { id: "w1", userId: "u1", name: "Wiki Linter" } as unknown as Watcher;

function botConfig(overrides: Partial<BotConfig>): BotConfig {
  return { name: "testbot", ...overrides } as BotConfig;
}

describe("checkWikiLinter", () => {
  let root: string;

  beforeEach(async () => {
    __resetWikiCacheForTest();
    root = await mkdtemp(path.join(tmpdir(), "wiki-linter-check-"));
    await mkdir(path.join(root, "concepts"), { recursive: true });
  });

  afterEach(async () => {
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("no wikiDir → skips with no alerts", async () => {
    const alerts = await checkWikiLinter(watcher, botConfig({}));
    expect(alerts).toEqual([]);
  });

  test("unreadable wiki → skips with no alerts", async () => {
    const alerts = await checkWikiLinter(
      watcher,
      botConfig({ wikiDir: path.join(root, "does-not-exist") }),
    );
    expect(alerts).toEqual([]);
  });

  test("clean wiki → no alerts", async () => {
    // Two pages linking each other, valid updated:, sources: frontmatter.
    await Bun.write(
      path.join(root, "concepts/A.md"),
      "---\ntype: concept\ntitle: A\nupdated: 2026-06-01\nsources: [x]\n---\n\nSee [[B]].",
    );
    await Bun.write(
      path.join(root, "concepts/B.md"),
      "---\ntype: concept\ntitle: B\nupdated: 2026-06-01\nsources: [x]\n---\n\nSee [[A]].",
    );
    const alerts = await checkWikiLinter(watcher, botConfig({ wikiDir: root }));
    expect(alerts).toEqual([]);
  });

  test("findings → ONE low-urgency alert with dated id, count summary, and gardener pointer", async () => {
    // One orphan page with a broken link and no updated:/sources.
    await Bun.write(
      path.join(root, "concepts/Messy.md"),
      "---\ntype: concept\ntitle: Messy\n---\n\nSee [[Missing Page]].",
    );
    const alerts = await checkWikiLinter(watcher, botConfig({ wikiDir: root }));
    expect(alerts.length).toBe(1);
    const alert = alerts[0]!;
    expect(alert.id).toMatch(/^wiki-lint-\d{4}-\d{2}-\d{2}$/);
    expect(alert.source).toBe("wiki-linter");
    expect(alert.urgency).toBe("low");
    // Counts: 1 broken link, 1 orphan, 1 stale updated:, 1 missing Sources.
    expect(alert.summary).toBe(
      "Wiki lint: 1 broken link, 1 orphan, 1 stale updated:, 1 missing Sources — review at /wiki/gardener",
    );
  });

  test("pluralizes counts in the summary", async () => {
    // Two orphans, each with a distinct broken link.
    await Bun.write(
      path.join(root, "concepts/M1.md"),
      "---\ntype: concept\ntitle: M1\nupdated: 2026-06-01\nsources: [x]\n---\n\nSee [[Gone One]].",
    );
    await Bun.write(
      path.join(root, "concepts/M2.md"),
      "---\ntype: concept\ntitle: M2\nupdated: 2026-06-01\nsources: [x]\n---\n\nSee [[Gone Two]].",
    );
    const alerts = await checkWikiLinter(watcher, botConfig({ wikiDir: root }));
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.summary).toContain("2 broken links");
    expect(alerts[0]!.summary).toContain("2 orphans");
  });
});
