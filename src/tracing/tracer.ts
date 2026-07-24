import { Timing, type TimingExtras } from "../utils/timing.ts";
import { saveSpan, updateSpan } from "../db/traces.ts";
import { loadConfig } from "../config.ts";
import { getLog } from "../logging.ts";

const log = getLog("tracing");

// Cached on first access — won't pick up env changes at runtime, which is fine
// since tracing is a startup-time configuration concern.
let _tracingEnabled: boolean | null = null;
function isTracingEnabled(): boolean {
  if (_tracingEnabled === null) {
    try {
      _tracingEnabled = loadConfig().tracingEnabled;
    } catch {
      _tracingEnabled = true;
    }
  }
  return _tracingEnabled;
}

export interface TraceContext {
  traceId: string;
  parentId: string;
}

interface TracerOpts {
  botName?: string;
  userId?: string;
  username?: string;
  platform?: string;
  traceId?: string;   // for child tracers (background tasks)
  parentId?: string;
}

interface SpanEntry {
  id: string;
  startedAt: Date;
  // Resolves when this span's INSERT has landed. end() chains the UPDATE on it
  // so the UPDATE can never race ahead of the INSERT on a different pool
  // connection (zero-duration spans would otherwise update 0 rows).
  insertPromise: Promise<unknown>;
}

export class Tracer {
  private timing: Timing;
  readonly traceId: string;
  private rootSpanId: string;
  private spans = new Map<string, SpanEntry>();
  private opts: TracerOpts;
  private enabled: boolean;
  // Resolves when the root span's INSERT has landed. finish()/error() chain the
  // root UPDATE on it so it can't race ahead of the INSERT.
  private rootInsertPromise: Promise<unknown> = Promise.resolve();

  constructor(name: string, opts: TracerOpts = {}) {
    this.timing = new Timing();
    this.opts = opts;
    this.enabled = isTracingEnabled();
    this.traceId = opts.traceId ?? crypto.randomUUID();
    this.rootSpanId = crypto.randomUUID();

    if (this.enabled) {
      this.rootInsertPromise = saveSpan({
        id: this.rootSpanId,
        traceId: this.traceId,
        parentId: opts.parentId ?? null,
        name,
        kind: opts.parentId ? "span" : "root",
        botName: opts.botName,
        userId: opts.userId,
        username: opts.username,
        platform: opts.platform,
        startedAt: new Date(),
      });
      // Standalone catch: keeps a never-finished trace from leaking an unhandled
      // rejection. Deliberate tradeoff: if finish() also runs, an insert failure
      // is logged twice (here + the chained update's catch).
      this.rootInsertPromise.catch(logError);
    }
  }

  /** Start a named span — same API as Timing.start() + writes span to DB */
  start(label: string, attributes?: Record<string, unknown>): string {
    this.timing.start(label);
    const id = crypto.randomUUID();

    let insertPromise: Promise<unknown> = Promise.resolve();
    if (this.enabled) {
      insertPromise = saveSpan({
        id,
        traceId: this.traceId,
        parentId: this.rootSpanId,
        name: label,
        kind: "span",
        botName: this.opts.botName,
        userId: this.opts.userId,
        startedAt: new Date(),
        attributes,
      });
      // Same deliberate double-log tradeoff as the root insert above: a span
      // that is never end()ed must not leak an unhandled rejection.
      insertPromise.catch(logError);
    }

    this.spans.set(label, { id, startedAt: new Date(), insertPromise });

    return id;
  }

  /** End a named span — same API as Timing.end() + updates span in DB */
  end(label: string, attributes?: Record<string, unknown>): number {
    const durationMs = this.timing.end(label);
    const span = this.spans.get(label);

    if (this.enabled && span) {
      // Chain the UPDATE on the span's INSERT so it can never run first on a
      // different pool connection (zero-duration spans would lose their update).
      span.insertPromise
        .then(() =>
          updateSpan(span.id, {
            durationMs: Math.round(durationMs),
            status: "ok",
            attributes,
          }),
        )
        .catch(logError);
    }

    return durationMs;
  }

  /** Merge attributes into an OPEN (already-started, not-yet-ended) span without
   *  ending it or touching its duration/status. Use when a value becomes known
   *  mid-span (e.g. the Haiku backend resolved inside a seam call, while the
   *  enclosing stage span stays open). No-op if tracing is disabled or the span
   *  isn't currently open; the later `end()` merges its own attrs on top. */
  annotate(label: string, attributes: Record<string, unknown>): void {
    const span = this.spans.get(label);
    if (!this.enabled || !span) return;
    // Chain on the INSERT so the attribute UPDATE can't race ahead of it.
    span.insertPromise
      .then(() => updateSpan(span.id, { attributes }))
      .catch(logError);
  }

  /** Create a completed child span under a named parent span (for pre-computed durations like tool calls).
   *  If startOffsetMs is provided, the span's start time is offset from the parent span's start.
   *  Status defaults to 'ok' in the DB schema.
   *  Returns the new span id (or a fresh uuid if tracing is disabled, so callers can chain regardless). */
  addChildSpan(
    parentLabel: string,
    name: string,
    durationMs: number,
    attributes?: Record<string, unknown>,
    startOffsetMs?: number,
  ): string {
    const id = crypto.randomUUID();
    if (!this.enabled) return id;

    const parentSpan = this.spans.get(parentLabel);
    const parentId = parentSpan?.id ?? this.rootSpanId;

    // No offset → anchor the bar's right edge at "now" (the call just ended).
    const startedAt = startOffsetMs != null && parentSpan
      ? new Date(parentSpan.startedAt.getTime() + startOffsetMs)
      : nowMinusDuration(durationMs);

    saveSpan({
      id,
      traceId: this.traceId,
      parentId,
      name,
      kind: "span",
      botName: this.opts.botName,
      userId: this.opts.userId,
      startedAt,
      durationMs: Math.round(durationMs),
      attributes,
    }).catch(logError);

    return id;
  }

  /** Create a completed child span under an arbitrary parent span id.
   *  Use when the parent isn't a label-tracked span — e.g. when nesting stage spans
   *  under a tool span that was itself produced by addChildSpan.
   *  startOffsetMs is anchored to parentStartedAt if provided, else "now − duration". */
  addSubSpan(
    parentSpanId: string,
    name: string,
    durationMs: number,
    attributes?: Record<string, unknown>,
    opts?: { startOffsetMs?: number; parentStartedAt?: Date },
  ): string {
    const id = crypto.randomUUID();
    if (!this.enabled) return id;

    const offset = opts?.startOffsetMs ?? 0;
    const anchor = opts?.parentStartedAt ?? nowMinusDuration(durationMs);
    const startedAt = new Date(anchor.getTime() + offset);

    saveSpan({
      id,
      traceId: this.traceId,
      parentId: parentSpanId,
      name,
      kind: "span",
      botName: this.opts.botName,
      userId: this.opts.userId,
      startedAt,
      durationMs: Math.round(durationMs),
      attributes,
    }).catch(logError);

    return id;
  }

  /** Point-in-time event (no duration) */
  event(label: string, attributes?: Record<string, unknown>): void {
    if (!this.enabled) return;

    saveSpan({
      id: crypto.randomUUID(),
      traceId: this.traceId,
      parentId: this.rootSpanId,
      name: label,
      kind: "event",
      botName: this.opts.botName,
      userId: this.opts.userId,
      startedAt: new Date(),
      durationMs: 0,
      attributes,
    }).catch(logError);
  }

  /** End root span with success */
  finish(status: "ok" | "error" = "ok", attributes?: Record<string, unknown>): void {
    if (!this.enabled) return;

    // Chain the root UPDATE on the root INSERT to avoid the same start/end race.
    this.rootInsertPromise
      .then(() =>
        updateSpan(this.rootSpanId, {
          durationMs: Math.round(this.totalMs()),
          status,
          attributes,
        }),
      )
      .catch(logError);
  }

  /** End root span with error */
  error(err: Error | string): void {
    const message = err instanceof Error ? err.message : err;
    this.finish("error", { error: message });
  }

  // Backward compat — delegates to Timing
  totalMs(): number {
    return this.timing.totalMs();
  }

  summary(): Record<string, number> {
    return this.timing.summary();
  }

  formatTelegram(extras?: TimingExtras): string {
    return this.timing.formatTelegram(extras);
  }

  /** Context for passing to background tasks (memory/goal/schedule extractors) */
  get context(): TraceContext {
    return { traceId: this.traceId, parentId: this.rootSpanId };
  }

  /** Start time of a label-tracked span, or undefined if not started.
   *  Useful when synthesizing sub-spans that need to anchor against a known parent. */
  spanStartedAt(label: string): Date | undefined {
    return this.spans.get(label)?.startedAt;
  }
}

function logError(err: unknown): void {
  log.error("Failed to write span: {error}", { error: err instanceof Error ? err.message : String(err) });
}

function nowMinusDuration(durationMs: number): Date {
  return new Date(Date.now() - Math.round(durationMs));
}
