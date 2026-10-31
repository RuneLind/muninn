/**
 * The `themes` kind's half of the organize run (plan `muninn-wiki-theme-map`,
 * P1): a rebuilt index (no claude-usage ledger, no sessions wait), the theme
 * digest, one model call through the shared seam, the theme answer schema
 * and normalize. `run.ts` hands the result to the same write tail the work
 * kind uses.
 */

import { getLog } from "../../logging.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { previousMapOf } from "./map-file.ts";
import type { RunOutcomes, WorkMapRunDeps } from "./run.ts";
import { callWorkMapModel, usageOf, type Built } from "./run-shared.ts";
import { buildThemeMapDigest, createdDayOf, isHubCandidate, THEME_MAP_SYSTEM_PROMPT, THEME_WINDOW_DAYS } from "./theme-digest.ts";
import { normalizeThemeAnswer } from "./theme-normalize.ts";
import { THEME_MAP_VERSION, themeAnswerSchema, type ThemeMap } from "./theme-schema.ts";
import { WORK_MAP_FILE } from "./write.ts";
import path from "node:path";

const log = getLog("wiki", "work-map");

/** A run whose active sources fall below this share of the previous run's warns. */
const THEME_DROP_WARN_RATIO = 0.5;

export async function buildThemeMap(
  entry: WikiRegistryEntry,
  deps: WorkMapRunDeps,
  runStart: number,
  signal: AbortSignal | undefined,
  outcomes: RunOutcomes,
  progress: { modelCalled: boolean },
): Promise<Built> {
  const { refuse, fail } = outcomes;
  const index = await deps.inputs.rebuildIndex(entry.root);
  if (signal?.aborted) return { result: { outcome: "aborted" } };
  if (!index) return { result: await refuse("the wiki index could not be built") };
  if (!index.gitTouches) return { result: await refuse("the rebuilt index carries no git history") };

  const previous = previousMapOf(await deps.readText(path.join(entry.root, WORK_MAP_FILE)), "themes");
  const digest = buildThemeMapDigest({ wiki: entry.name, nowMs: runStart, pages: index.pages, outgoing: index.outgoing, previous });
  if (digest.active.length === 0) return { result: await refuse(`no source page was created in the last ${THEME_WINDOW_DAYS} days`) };

  const warnings: string[] = [];
  if (digest.cut > 0) warnings.push(`The digest listed the newest ${digest.active.length - digest.cut} of ${digest.active.length} sources; ${digest.cut} older ones reached no theme.`);
  const prevActive = previous?.coverage.activeSources;
  if (prevActive && digest.active.length < prevActive * THEME_DROP_WARN_RATIO) {
    warnings.push(`Active sources fell from ${prevActive} to ${digest.active.length} since the previous run.`);
  }

  const called = await callWorkMapModel(entry, deps, digest.text, THEME_MAP_SYSTEM_PROMPT, signal, outcomes, progress);
  if ("result" in called) return called;
  const { reply, raw } = called;
  const parsed = themeAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { result: await fail(`the answer did not match the schema (${issues})`) };
  }
  const byRel = new Map(index.pages.map((p) => [p.relPath, p]));
  const normalized = normalizeThemeAnswer(parsed.data, {
    rel: digest.rel,
    sources: new Map(digest.active.map((s) => [s.relPath, s])),
    hubs: digest.hubs,
    hubByName: digest.hubByName,
    resolveHub: (name) => {
      if (digest.ambiguousHubNames.has(name.toLowerCase())) return undefined;
      const p = index.resolve(name);
      return p && isHubCandidate(p) ? p.relPath : undefined;
    },
    createdDayOf: (rel) => {
      const p = byRel.get(rel);
      return p ? createdDayOf(p) : undefined;
    },
    runDay: digest.runDay,
    previous,
  });
  const placed = normalized.efforts.reduce((n, e) => n + e.pages.length, 0);
  const map: ThemeMap = {
    version: THEME_MAP_VERSION,
    kind: "themes",
    wiki: entry.name,
    runAtMs: runStart,
    model: reply.model ?? deps.config.workMapModel,
    coverage: {
      activeSources: digest.active.length,
      hubs: digest.hubs.length,
      driftHubs: digest.hubs.filter((h) => h.drift).length,
      placed,
      digestChars: digest.text.length,
      windowDays: THEME_WINDOW_DAYS,
      warnings,
    },
    ...normalized,
    usage: usageOf(reply),
  };
  return {
    map,
    commitMessage: `work-map: organize ${entry.name} (${map.efforts.length} themes)`,
    logDone: () =>
      log.info("Theme map for {wiki}: {themes} theme(s), {placed}/{active} source(s) placed, {needs} worth a look", {
        wiki: entry.name,
        themes: map.efforts.length,
        placed,
        active: digest.active.length,
        needs: map.needsYou.length,
      }),
  };
}
