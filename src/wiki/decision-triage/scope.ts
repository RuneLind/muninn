/**
 * Which wikis the decision triage may read and spend on: one definition for the
 * loop, the run script and the judge. A wiki needs a registered root, answer cards,
 * a `work` map and no readonly root. `covered` keeps `WORK_MAP_WIKIS`' order.
 * `fault` separates what should work and does not from what the slice leaves out.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Config, WikiAnswerConfig } from "../../config.ts";
import { listWikiAnswerHistory } from "../../db/wiki-answers.ts";
import { isReadonlyWikiRoot } from "../readonly.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { getWikiIndex } from "../store.ts";
import { workMapKindFromReaderText } from "../work-map/kind.ts";
import { WIKI_READER_FILE } from "../work-map/run.ts";
import { computeFloor } from "./floor.ts";
import { realGit } from "./git.ts";
import type { TriageRunDeps } from "./run.ts";

export interface DroppedWiki {
  wiki: string;
  reason: string;
  fault: boolean;
}

export interface TriageScope {
  covered: WikiRegistryEntry[];
  dropped: DroppedWiki[];
}

async function dropReason(entry: WikiRegistryEntry, isReadonlyRoot: (root: string) => boolean): Promise<Omit<DroppedWiki, "wiki"> | null> {
  if (isReadonlyRoot(entry.root)) return { fault: true, reason: "a readonly root (WIKI_READONLY_ROOTS)" };
  if (!(await stat(entry.root).then((s) => s.isDirectory()).catch(() => false))) return { fault: true, reason: "its root does not exist" };
  let text: string | null;
  try {
    text = await readFile(path.join(entry.root, WIKI_READER_FILE), "utf8");
  } catch (err) {
    // As the work map's run: only no file reads as `work`. An EIO must not spend on a themes wiki.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { fault: true, reason: `${WIKI_READER_FILE} exists but could not be read` };
    text = null;
  }
  const kind = workMapKindFromReaderText(text);
  if (!kind.ok) return { fault: true, reason: kind.reason };
  return kind.kind === "work" ? null : { fault: false, reason: `a ${kind.kind} map` };
}

export async function triageScope(deps: {
  workMapWikis: readonly string[];
  /** Lowercase names, as `resolveWikiAnswerConfig` holds them. */
  answerWikis: ReadonlySet<string>;
  entryOf: (name: string) => WikiRegistryEntry | undefined;
  isReadonlyRoot?: (root: string) => boolean;
}): Promise<TriageScope> {
  const scope: TriageScope = { covered: [], dropped: [] };
  const seen = new Set<string>();
  for (const name of deps.workMapWikis) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!deps.answerWikis.has(key)) {
      scope.dropped.push({ wiki: name, fault: false, reason: "not in WIKI_ANSWER_WIKIS" });
      continue;
    }
    const entry = deps.entryOf(name);
    if (!entry) {
      scope.dropped.push({ wiki: name, fault: true, reason: "no root here: pass --root, or register it" });
      continue;
    }
    const dropped = await dropReason(entry, deps.isReadonlyRoot ?? isReadonlyWikiRoot);
    if (dropped) scope.dropped.push({ wiki: name, ...dropped });
    else scope.covered.push(entry);
  }
  return scope;
}

/** A wiki's standing in a scope, for a script naming it: its entry, or why not. */
export function scopeVerdict(scope: TriageScope, wiki: string): { entry: WikiRegistryEntry } | { reason: string } {
  const key = wiki.toLowerCase();
  const entry = scope.covered.find((e) => e.name.toLowerCase() === key);
  if (entry) return { entry };
  const dropped = scope.dropped.find((d) => d.wiki.toLowerCase() === key);
  return { reason: `${wiki}: ${dropped?.reason ?? "not in WORK_MAP_WIKIS"}` };
}

/** One night's real deps: the loop's and the run script's differ only in the sink and the floor's wikis. */
export function realTriageRunDeps(
  config: Config,
  entry: WikiRegistryEntry,
  answerConfig: Pick<WikiAnswerConfig, "owner" | "groups">,
  opts: {
    append: TriageRunDeps["append"];
    floorEntries: () => readonly WikiRegistryEntry[];
    signal?: AbortSignal;
    /** The night's log folder, when `append` writes there; a run elsewhere starts no window. */
    nightlyDir?: string;
  },
): TriageRunDeps {
  return {
    entry,
    now: Date.now,
    repoRoots: config.decisionTriageRepoRoots,
    model: config.workMapModel,
    ...(config.workMapEffort ? { effort: config.workMapEffort } : {}),
    // D19's stop trigger: the night asks no model. `--replay` keeps the real call.
    call: null,
    git: realGit,
    loadIndex: () => getWikiIndex({ root: entry.root, refresh: true }),
    readFile: async (abs) => {
      try {
        return await Bun.file(abs).text();
      } catch {
        return null;
      }
    },
    answers: () => listWikiAnswerHistory(entry.name),
    owner: answerConfig.owner,
    groups: answerConfig.groups,
    append: opts.append,
    floor: (startedAt) =>
      computeFloor(opts.floorEntries().map((e) => ({ wiki: e.name, root: e.root })), listWikiAnswerHistory, realGit, opts.nightlyDir === undefined ? {} : { dir: opts.nightlyDir, ownLineAt: startedAt }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}
