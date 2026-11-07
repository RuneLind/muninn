/**
 * Is the nightly pass on, and which wikis does it cover: the loop's own gates
 * (`workMapLoopOff`, `workMapCoverage`), then the triage's switch and its scope
 * (`triageScope`), read from the config now. The /models card and the status
 * line read this; the loop decided the same at boot, so a registry or
 * readonly flip since then can differ from what the running loop holds.
 */

import type { Config } from "../../config.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { workMapCoverage, workMapLoopOff } from "../work-map/loop.ts";
import { NIGHTLY_MODEL_OFF, triageScope } from "./scope.ts";

export interface TriagePassView {
  on: boolean;
  /** Why the pass is off; null when on. */
  why: string | null;
  /** The night calls no model (`NIGHTLY_MODEL_OFF`). */
  modelOff: boolean;
  /** The model the night would call: the work map's. */
  model: string;
  /** The Europe/Oslo hour a night may start from. */
  hour: number;
  covered: string[];
  skipped: { wiki: string; reason: string }[];
}

export interface TriagePassDeps {
  registry: () => readonly WikiRegistryEntry[];
  isReadonly: () => boolean;
  isReadonlyRoot: (root: string) => boolean;
  /** Lowercase names, as `resolveWikiAnswerConfig` holds them. */
  answerWikis: () => ReadonlySet<string>;
}

export async function triagePassView(
  config: Pick<Config, "schedulerEnabled" | "workMapWikis" | "workMapHour" | "workMapModel" | "profile" | "decisionTriageRepoRoots">,
  deps: TriagePassDeps,
): Promise<TriagePassView> {
  const base = { modelOff: NIGHTLY_MODEL_OFF, model: config.workMapModel, hour: config.workMapHour };
  const gate = workMapLoopOff(config, deps.isReadonly);
  if (gate) return { ...base, on: false, why: gate.why, covered: [], skipped: [] };
  const registry = deps.registry();
  const loop = workMapCoverage(config.workMapWikis, registry, deps.isReadonlyRoot);
  const scope = await triageScope({
    workMapWikis: loop.covered,
    answerWikis: deps.answerWikis(),
    entryOf: (name) => registry.find((e) => e.name.toLowerCase() === name.toLowerCase()),
    isReadonlyRoot: deps.isReadonlyRoot,
  });
  const covered = scope.covered.map((e) => e.name);
  const skipped = [...loop.skipped, ...scope.dropped.map(({ wiki, reason }) => ({ wiki, reason }))];
  const why = !config.decisionTriageRepoRoots ? "DECISION_TRIAGE_REPO_ROOTS is not set" : covered.length === 0 ? "no wiki is in scope" : null;
  return { ...base, on: why === null, why, covered, skipped };
}
