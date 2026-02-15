import { Timing, type TimingExtras } from "../utils/timing.ts";
import { saveSpan, updateSpan } from "../db/traces.ts";
import { loadConfig } from "../config.ts";

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
}

export class Tracer {
  private timing: Timing;
  readonly traceId: string;
  private rootSpanId: string;
  private spans = new Map<string, SpanEntry>();
  private opts: TracerOpts;
  private enabled: boolean;

  constructor(name: string, opts: TracerOpts = {}) {
    this.timing = new Timing();
    this.opts = opts;
    this.enabled = isTracingEnabled();
    this.traceId = opts.traceId ?? crypto.randomUUID();
    this.rootSpanId = crypto.randomUUID();

    if (this.enabled) {
      saveSpan({
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
      }).catch(logError);
    }
  }

  /** Start a named span — same API as Timing.start() + writes span to DB */
  start(label: string, attributes?: Record<string, unknown>): string {
    this.timing.start(label);
    const id = crypto.randomUUID();
    this.spans.set(label, { id, startedAt: new Date() });

    if (this.enabled) {
      saveSpan({
        id,
        traceId: this.traceId,
        parentId: this.rootSpanId,
        name: label,
        kind: "span",
        botName: this.opts.botName,
        userId: this.opts.userId,
        startedAt: new Date(),
        attributes,
      }).catch(logError);
    }

    return id;
  }

  /** End a named span — same API as Timing.end() + updates span in DB */
  end(label: string, attributes?: Record<string, unknown>): number {
    const durationMs = this.timing.end(label);
    const span = this.spans.get(label);

    if (this.enabled && span) {
      updateSpan(span.id, {
        durationMs: Math.round(durationMs),
        status: "ok",
        attributes,
      }).catch(logError);
    }

    return durationMs;
  }

  /** Create a completed child span under a named parent span (for pre-computed durations like tool calls).
   *  Status defaults to 'ok' in the DB schema. */
  addChildSpan(
    parentLabel: string,
    name: string,
    durationMs: number,
    attributes?: Record<string, unknown>,
  ): void {
    if (!this.enabled) return;

    const parentSpan = this.spans.get(parentLabel);
    const parentId = parentSpan?.id ?? this.rootSpanId;

    saveSpan({
      id: crypto.randomUUID(),
      traceId: this.traceId,
      parentId,
      name,
      kind: "span",
      botName: this.opts.botName,
      userId: this.opts.userId,
      startedAt: new Date(),
      durationMs: Math.round(durationMs),
      attributes,
    }).catch(logError);
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

    updateSpan(this.rootSpanId, {
      durationMs: Math.round(this.totalMs()),
      status,
      attributes,
    }).catch(logError);
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
}

function logError(err: unknown): void {
  console.error("[tracing] Failed to write span:", err);
}
