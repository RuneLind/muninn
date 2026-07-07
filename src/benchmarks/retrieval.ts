/**
 * Offline retrieval eval — a fixed golden set of queries with expected doc
 * ids, run against three retrieval seams (huginn `/api/search`, memory hybrid
 * search, the research decomposition flow). Scoring is pure set-overlap
 * (hit@k / recall@k / MRR) — no LLM judge.
 *
 * This is deliberately a sibling of the analysis benchmark infra
 * (`cell.ts` / `treatment-discovery.ts`) rather than a reuse of it: the
 * runner here has no worktrees, no processMessage, no judge — just
 * "run search, compare ids, aggregate, persist one row".
 *
 * Fixtures live in the gitignored `/benchmarks/retrieval/*.jsonl` (same
 * local-only policy as `benchmarks/issues` and `benchmarks/rag`, since the
 * golden set references real Jira issue ids). The memory-target rows point at
 * synthetic fixtures seeded into the TEST database only (see
 * `retrieval-fixtures.ts`); when those aren't present the memory target is
 * skipped with a log line rather than failing the run.
 */

import { readdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getLog } from "../logging.ts";
import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import { researchKnowledge } from "../ai/research-knowledge.ts";
import { searchMemoriesHybrid } from "../db/memories.ts";
import { generateEmbedding } from "../ai/embeddings.ts";
import {
  saveRetrievalRun,
  completeRetrievalRun,
} from "../db/benchmark-retrieval-runs.ts";
import { hasSeededMemoryFixtures, MEMORY_FIXTURE_USER_ID } from "./retrieval-fixtures.ts";
import type { ConnectorType } from "../bots/config.ts";

const log = getLog("benchmarks", "retrieval");

export const RETRIEVAL_TARGETS = ["huginn", "memories", "research"] as const;
export type RetrievalTarget = (typeof RETRIEVAL_TARGETS)[number];

/** Default cutoff when a golden row doesn't specify `k`. */
export const DEFAULT_K = 10;

export interface RetrievalQuery {
  id: string;
  target: RetrievalTarget;
  query: string;
  /** Optional huginn/research collection to scope the search. */
  collection?: string;
  expectedDocIds: string[];
  /** Cutoff for hit@k / recall@k. Defaults to {@link DEFAULT_K}. */
  k?: number;
  note?: string;
}

export interface DiscoveredRetrievalSet {
  /** Absolute path to the golden-set jsonl file. */
  path: string;
  /** File basename without .jsonl. */
  label: string;
  queries: RetrievalQuery[];
}

/** Per-query score row persisted in `per_query`. */
export interface QueryMetrics {
  id: string;
  target: RetrievalTarget;
  k: number;
  expectedCount: number;
  returnedCount: number;
  /** 1 if any expected id appears in the top-k, else 0. */
  hitAtK: number;
  /** |expected ∩ topK| / |expected| (0 when there are no expected ids). */
  recallAtK: number;
  /** 1 / (rank of first expected id within top-k); 0 if none matched. */
  reciprocalRank: number;
  /** Expected ids found in the top-k (for eyeballing failures). */
  matched: string[];
  /** Set when the search itself failed (counted as a zero-score query). */
  error?: string;
  /** Set when the query was skipped (e.g. memory fixtures not seeded). */
  skipped?: boolean;
}

export interface AggregateMetrics {
  queryCount: number;
  /** Mean hit@k (a.k.a. hit rate). */
  hitRate: number;
  /** Mean recall@k. */
  recallAtK: number;
  /** Mean reciprocal rank. */
  mrr: number;
}

export interface RetrievalMetrics {
  overall: AggregateMetrics;
  /** Keyed by target; only targets that actually ran appear. */
  perTarget: Partial<Record<RetrievalTarget, AggregateMetrics>>;
}

// ── Pure metric math ────────────────────────────────────────────────────────

/**
 * Score one query's ranked result ids against its expected ids.
 * `rankedIds` is the search output in rank order (best first); it is
 * truncated to top-k internally, so callers pass the full ranked list.
 */
export function computeQueryMetrics(
  query: Pick<RetrievalQuery, "id" | "target" | "expectedDocIds" | "k">,
  rankedIds: string[],
): QueryMetrics {
  const k = query.k && query.k > 0 ? query.k : DEFAULT_K;
  const expected = query.expectedDocIds;
  const expectedSet = new Set(expected);
  const topK = rankedIds.slice(0, k);

  const matched: string[] = [];
  let firstRank = 0; // 1-based rank of first expected id within top-k
  for (let i = 0; i < topK.length; i++) {
    const id = topK[i]!;
    if (expectedSet.has(id)) {
      if (!matched.includes(id)) matched.push(id);
      if (firstRank === 0) firstRank = i + 1;
    }
  }

  const expectedCount = expected.length;
  const recallAtK = expectedCount === 0 ? 0 : matched.length / expectedCount;
  const hitAtK = matched.length > 0 ? 1 : 0;
  const reciprocalRank = firstRank > 0 ? 1 / firstRank : 0;

  return {
    id: query.id,
    target: query.target,
    k,
    expectedCount,
    returnedCount: rankedIds.length,
    hitAtK,
    recallAtK,
    reciprocalRank,
    matched,
  };
}

/** Aggregate a set of per-query metrics into overall + per-target means. */
export function aggregateMetrics(perQuery: QueryMetrics[]): RetrievalMetrics {
  const scored = perQuery.filter((q) => !q.skipped);

  const mean = (rows: QueryMetrics[], pick: (q: QueryMetrics) => number): number =>
    rows.length === 0 ? 0 : rows.reduce((s, q) => s + pick(q), 0) / rows.length;

  const summarize = (rows: QueryMetrics[]): AggregateMetrics => ({
    queryCount: rows.length,
    hitRate: mean(rows, (q) => q.hitAtK),
    recallAtK: mean(rows, (q) => q.recallAtK),
    mrr: mean(rows, (q) => q.reciprocalRank),
  });

  const perTarget: Partial<Record<RetrievalTarget, AggregateMetrics>> = {};
  for (const target of RETRIEVAL_TARGETS) {
    const rows = scored.filter((q) => q.target === target);
    if (rows.length > 0) perTarget[target] = summarize(rows);
  }

  return { overall: summarize(scored), perTarget };
}

// ── Fixture parsing + discovery ─────────────────────────────────────────────

interface RawGoldenRow {
  id?: unknown;
  target?: unknown;
  query?: unknown;
  collection?: unknown;
  expected_doc_ids?: unknown;
  k?: unknown;
  note?: unknown;
}

/**
 * Parse + validate one golden-set jsonl row. Returns null (with a warning) for
 * malformed rows so a single bad line doesn't take out the whole set.
 */
export function parseRetrievalRow(raw: unknown, source = "?"): RetrievalQuery | null {
  if (!raw || typeof raw !== "object") {
    log.warn("Skipping non-object golden row in {source}", { source });
    return null;
  }
  const r = raw as RawGoldenRow;
  if (typeof r.id !== "string" || r.id.length === 0) {
    log.warn("Skipping golden row with missing id in {source}", { source });
    return null;
  }
  if (typeof r.target !== "string" || !RETRIEVAL_TARGETS.includes(r.target as RetrievalTarget)) {
    log.warn("Skipping golden row {id}: invalid target {target}", { id: r.id, target: String(r.target) });
    return null;
  }
  if (typeof r.query !== "string" || r.query.trim().length === 0) {
    log.warn("Skipping golden row {id}: empty query", { id: r.id });
    return null;
  }
  if (!Array.isArray(r.expected_doc_ids) || r.expected_doc_ids.some((x) => typeof x !== "string")) {
    log.warn("Skipping golden row {id}: expected_doc_ids must be a string[]", { id: r.id });
    return null;
  }
  const out: RetrievalQuery = {
    id: r.id,
    target: r.target as RetrievalTarget,
    query: r.query,
    expectedDocIds: r.expected_doc_ids as string[],
  };
  if (typeof r.collection === "string" && r.collection.length > 0) out.collection = r.collection;
  if (typeof r.k === "number" && Number.isFinite(r.k) && r.k > 0) out.k = Math.floor(r.k);
  if (typeof r.note === "string" && r.note.length > 0) out.note = r.note;
  return out;
}

/** Parse a jsonl blob into validated queries (blank lines skipped). */
export function parseRetrievalSet(text: string, source = "?"): RetrievalQuery[] {
  const out: RetrievalQuery[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      log.warn("Skipping unparseable golden line in {source}", { source });
      continue;
    }
    const parsed = parseRetrievalRow(raw, source);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Discover every `benchmarks/retrieval/*.jsonl` golden set. Mirrors
 * `discoverTreatments` — filesystem glob, skip-on-error, sorted by label.
 */
export async function discoverRetrievalSets(
  benchmarksDir = "benchmarks",
): Promise<DiscoveredRetrievalSet[]> {
  const dir = resolve(benchmarksDir, "retrieval");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const out: DiscoveredRetrievalSet[] = [];
  for (const file of files) {
    const path = resolve(dir, file);
    try {
      const text = await readFile(path, "utf8");
      const queries = parseRetrievalSet(text, file);
      out.push({ path, label: file.replace(/\.jsonl$/, ""), queries });
    } catch (err) {
      log.warn("Skipping unreadable golden set {path}: {error}", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ── Search adapters ─────────────────────────────────────────────────────────

/** Returns ranked doc ids (best first) for one query, or null when skipped. */
export type SearchRunner = (query: RetrievalQuery) => Promise<string[] | null>;

export interface SearchRunners {
  huginn: SearchRunner;
  research: SearchRunner;
  memories: SearchRunner;
}

interface HuginnSearchResponse {
  results?: Array<{ id?: unknown; collection?: unknown }>;
}

/** Build the default live search runners from the eval options. */
export function defaultSearchRunners(opts: RunRetrievalEvalOptions): SearchRunners {
  const { knowledgeApiUrl } = opts;

  const huginn: SearchRunner = async (q) => {
    const params = new URLSearchParams({ q: q.query });
    if (q.collection) params.append("collection", q.collection);
    params.set("limit", String((q.k && q.k > 0 ? q.k : DEFAULT_K) + 5));
    const resp = (await fetchKnowledgeApi(knowledgeApiUrl, `/api/search?${params}`, {
      timeoutMs: opts.searchTimeoutMs ?? 15_000,
    })) as HuginnSearchResponse;
    const results = Array.isArray(resp.results) ? resp.results : [];
    return results.map((r) => (typeof r.id === "string" ? r.id : "")).filter((id) => id.length > 0);
  };

  const research: SearchRunner = async (q) => {
    const result = await researchKnowledge({
      question: q.query,
      collections: q.collection ? [q.collection] : undefined,
      limit: q.k && q.k > 0 ? q.k : DEFAULT_K,
      botName: opts.botName,
      botDir: opts.botDir,
      knowledgeApiUrl,
      connector: opts.connector,
    });
    return result.results.map((h) => h.id);
  };

  const memories: SearchRunner = async (q) => {
    const seeded = await hasSeededMemoryFixtures();
    if (!seeded) {
      log.info("Skipping memory-target query {id}: no seeded fixtures in this DB", { id: q.id });
      return null;
    }
    const embedding = await generateEmbedding(q.query).catch(() => null);
    const hits = await searchMemoriesHybrid(
      opts.memoryUserId ?? MEMORY_FIXTURE_USER_ID,
      q.query,
      embedding,
      (q.k && q.k > 0 ? q.k : DEFAULT_K) + 5,
      opts.memoryBotName,
    );
    return hits.map((m) => m.id);
  };

  return { huginn, research, memories };
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface RunRetrievalEvalOptions {
  queries: RetrievalQuery[];
  knowledgeApiUrl: string;
  /** Bot context for the research decomposition path. */
  botName: string;
  botDir?: string;
  connector?: ConnectorType;
  /** Restrict the run to a single target. */
  target?: RetrievalTarget;
  /** User id to search memories under (defaults to the fixture user). */
  memoryUserId?: string;
  /** Optional bot-name scope for memory search. */
  memoryBotName?: string;
  searchTimeoutMs?: number;
  notes?: string;
  /** Skip DB persistence (unit tests / dry runs). */
  persist?: boolean;
  /** Injected runners — defaults to the live ones. Used by tests. */
  runners?: SearchRunners;
}

export interface RetrievalEvalResult {
  runId: string | null;
  metrics: RetrievalMetrics;
  perQuery: QueryMetrics[];
}

/**
 * Run the golden set against its targets, compute per-query + aggregate
 * metrics, and (unless `persist === false`) write one row to
 * `benchmark_retrieval_runs`.
 */
export async function runRetrievalEval(
  opts: RunRetrievalEvalOptions,
): Promise<RetrievalEvalResult> {
  const persist = opts.persist !== false;
  const selected = opts.target
    ? opts.queries.filter((q) => q.target === opts.target)
    : opts.queries;

  const runners = opts.runners ?? defaultSearchRunners(opts);

  let runId: string | null = null;
  if (persist) {
    runId = await saveRetrievalRun({
      startedAt: new Date(),
      targetFilter: opts.target ?? null,
      queryCount: selected.length,
      huginnBaseUrl: opts.knowledgeApiUrl,
      notes: opts.notes ?? null,
    });
  }

  const perQuery: QueryMetrics[] = [];
  try {
    for (const query of selected) {
      const runner = runners[query.target];
      try {
        const rankedIds = await runner(query);
        if (rankedIds === null) {
          perQuery.push({
            id: query.id,
            target: query.target,
            k: query.k && query.k > 0 ? query.k : DEFAULT_K,
            expectedCount: query.expectedDocIds.length,
            returnedCount: 0,
            hitAtK: 0,
            recallAtK: 0,
            reciprocalRank: 0,
            matched: [],
            skipped: true,
          });
          continue;
        }
        perQuery.push(computeQueryMetrics(query, rankedIds));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Query {id} ({target}) failed: {error}", {
          id: query.id,
          target: query.target,
          error: message,
        });
        perQuery.push({
          id: query.id,
          target: query.target,
          k: query.k && query.k > 0 ? query.k : DEFAULT_K,
          expectedCount: query.expectedDocIds.length,
          returnedCount: 0,
          hitAtK: 0,
          recallAtK: 0,
          reciprocalRank: 0,
          matched: [],
          error: message,
        });
      }
    }

    const metrics = aggregateMetrics(perQuery);

    if (persist && runId) {
      await completeRetrievalRun(runId, {
        finishedAt: new Date(),
        status: "done",
        metrics,
        perQuery,
      });
    }

    return { runId, metrics, perQuery };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (persist && runId) {
      await completeRetrievalRun(runId, {
        finishedAt: new Date(),
        status: "error",
        error: message,
        perQuery,
      }).catch(() => {});
    }
    throw err;
  }
}
