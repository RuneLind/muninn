/**
 * The run deps behind `scripts/work-map-dry-run.ts`: the real organize run on
 * one wiki with every side effect but the model call redirected. Its own run
 * config (no `WORK_MAP_WIKIS` entry needed), an in-memory state store (never
 * `~/.muninn/work-map/`), the previous map from a file of the caller's
 * choosing instead of the wiki root, the map written to `out` and nothing
 * committed. The model call keeps its trace and `/agents` row.
 */

import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MuninnProfile, WorkMapEffort } from "../../config.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { realWarmInputDeps, type WarmInputDeps } from "./inputs.ts";
import { workMapKindFromReaderText } from "./kind.ts";
import { readMapFile } from "./map-file.ts";
import { WIKI_READER_FILE, type ModelReply, type ModelRequest, type WorkMapRunDeps } from "./run.ts";
import type { WorkMapAttempt, WorkMapState, WorkMapStateStore } from "./state.ts";
import { WORK_MAP_FILE } from "./write.ts";

export interface DryRunOptions {
  entry: WikiRegistryEntry;
  model: string;
  effort?: WorkMapEffort;
  profile: MuninnProfile;
  /** Where the map goes. Refused inside the wiki root. */
  out: string;
  /** The previous map's file; absent ⇒ no previous map. */
  previous?: string;
  /** Replay this saved answer (`--answer`) instead of calling the model: the
   *  run's clock is the saved one, and a digest that differs from the saved
   *  prompt refuses the replay (the wiki changed, so short ids moved). */
  answer?: SavedAnswer;
  /** Save the answer, its prompt and the run's clock here. */
  saveAnswer?: string;
  callModel: (req: ModelRequest) => Promise<ModelReply>;
  inputs?: WarmInputDeps;
  now?: () => number;
}

/** What `--save-answer` writes and `--answer` replays. */
export interface SavedAnswer {
  nowMs: number;
  prompt: string;
  text: string;
  model?: string;
}

/** Parse a `--save-answer` file; throws on another shape. */
export function parseSavedAnswer(text: string): SavedAnswer {
  const raw = JSON.parse(text) as Partial<SavedAnswer>;
  if (typeof raw.nowMs !== "number" || typeof raw.prompt !== "string" || typeof raw.text !== "string") {
    throw new Error("not a --save-answer file (needs nowMs, prompt and text)");
  }
  return { nowMs: raw.nowMs, prompt: raw.prompt, text: raw.text, ...(typeof raw.model === "string" ? { model: raw.model } : {}) };
}

/** An in-memory attempt store. */
export function memoryStateStore(): WorkMapStateStore {
  const states = new Map<string, WorkMapState>();
  return {
    async read(wiki) {
      return states.get(wiki.toLowerCase()) ?? null;
    },
    async record(wiki, a: WorkMapAttempt) {
      const prev = states.get(wiki.toLowerCase());
      const next: WorkMapState = {
        wiki,
        attempts: [a, ...(prev?.attempts ?? [])],
        ...(a.outcome === "ok" ? { lastSuccessAt: a.at } : prev?.lastSuccessAt !== undefined ? { lastSuccessAt: prev.lastSuccessAt } : {}),
      };
      states.set(wiki.toLowerCase(), next);
      return next;
    },
  };
}

/** `abs` with symlinks resolved; a path not made yet resolves through its
 *  nearest existing ancestor. Throws when no ancestor resolves. */
function canonical(abs: string): string {
  const rest: string[] = [];
  let at = path.resolve(abs);
  for (;;) {
    try {
      return path.join(realpathSync(at), ...rest.reverse());
    } catch (err) {
      const parent = path.dirname(at);
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || parent === at) throw err;
      rest.push(path.basename(at));
      at = parent;
    }
  }
}

/** Is `file` inside `root`, symlinks resolved? Unsure (a path that cannot be resolved) counts as inside. */
const inside = (root: string, file: string) => {
  let rel: string;
  try {
    rel = path.relative(canonical(root), canonical(file));
  } catch {
    return true;
  }
  return !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
};

export function dryRunDeps(opts: DryRunOptions): WorkMapRunDeps {
  const root = path.resolve(opts.entry.root);
  for (const [flag, file] of [["--out", opts.out], ["--save-answer", opts.saveAnswer]] as const) {
    if (file && inside(root, file)) throw new Error(`${flag} ${file} is inside the wiki root (or could not be resolved); the dry run writes nothing there`);
  }
  const mapPath = path.join(root, WORK_MAP_FILE);
  const readOrNull = async (file: string) => {
    try {
      return await readFile(file, "utf8");
    } catch {
      return null;
    }
  };
  // A given --previous must be a map of this wiki's kind: one that reads as
  // none would turn the run into a first run without saying so.
  const readPrevious = async (file: string) => {
    const text = await readOrNull(file);
    if (text === null) throw new Error(`--previous ${file} could not be read`);
    const stored = readMapFile(text);
    if (!stored) throw new Error(`--previous ${file} is not a work map file`);
    const kind = workMapKindFromReaderText(await readOrNull(path.join(root, WIKI_READER_FILE)));
    if (kind.ok && stored.kind !== kind.kind) throw new Error(`--previous ${file} is a ${stored.kind} map, not a ${kind.kind} map`);
    return text;
  };
  let startedAt = 0;
  return {
    config: {
      workMapWikis: [opts.entry.name],
      workMapModel: opts.model,
      ...(opts.effort ? { workMapEffort: opts.effort } : {}),
      schedulerEnabled: true,
      profile: opts.profile,
    },
    now: () => (startedAt = opts.answer ? opts.answer.nowMs : (opts.now ?? Date.now)()),
    registry: () => [{ ...opts.entry, root }],
    inputs: opts.inputs ?? realWarmInputDeps(),
    readText: async (abs) => {
      if (path.resolve(abs) === mapPath) return opts.previous ? readPrevious(opts.previous) : null;
      return readOrNull(abs);
    },
    exists: (abs) => Bun.file(abs).exists(),
    model: async (req) => {
      if (opts.answer) {
        if (opts.answer.prompt !== req.prompt) throw new Error("the digest differs from the saved prompt (the wiki or --previous changed); a replay would misread its short ids");
        return { text: opts.answer.text, model: opts.answer.model ?? req.model };
      }
      const reply = await opts.callModel(req);
      if (opts.saveAnswer) {
        const saved: SavedAnswer = { nowMs: startedAt, prompt: req.prompt, text: reply.text, ...(reply.model ? { model: reply.model } : {}) };
        await mkdir(path.dirname(opts.saveAnswer), { recursive: true });
        await writeFile(opts.saveAnswer, JSON.stringify(saved));
      }
      return reply;
    },
    write: async (w) => {
      await mkdir(path.dirname(opts.out), { recursive: true });
      await writeFile(opts.out, w.content);
      return { outcome: "written" };
    },
    commit: null,
    state: memoryStateStore(),
  };
}
