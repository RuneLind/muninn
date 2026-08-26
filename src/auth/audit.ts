/**
 * The audit trail for the two ways an admin reaches somebody else's data.
 *
 * LogTape lines for both already existed (`guard.ts`'s admin passthrough and
 * `resource-guard.ts`'s owned-resource read). What they cannot do is show up on
 * the operator's own feed, which is where a person would actually notice one —
 * so both shapes now also write an `activity_log` row, replayed on
 * `GET /api/events` and persisted for as long as the table keeps it.
 *
 * ## Two shapes, one difference
 *
 *  - **Passthrough** — an id-addressed route where the row HAS an owner. The
 *    line names the reader AND the owner, because "who was read" is the whole
 *    fact. Deduped per (reader, kind, resource) — it hooks
 *    `requireOwnedResource`, which sits on POLLED routes (`GET
 *    /api/jira/drafts?thread=` at 60–600s, `GET /api/traces/:id`), so an
 *    operator watching a colleague's thread would otherwise write one row per
 *    tick.
 *  - **Collection read** — one of the unfiltered lists in
 *    `AUDITED_COLLECTION_PATHS`. There is no single owner, so the line names
 *    the reader and the ROUTE. This half is hooked in exactly one place, the
 *    zone middleware, from one path list — the `SIDE_EFFECTING_GETS` idiom.
 *    Deduped per (reader, route).
 *
 * ## Three properties that are not obvious
 *
 * **The row means an ATTEMPTED read.** The collection hook writes BEFORE the
 * handler runs, so a 404, a 500 or an empty result still rows. An audit trail
 * that only records successes is one an attacker can walk quietly.
 *
 * **The type is `system`.** `activity_log.type` carries a DB CHECK
 * (`db/init.sql`), and `ActivityLog.push` persists fire-and-forget with a
 * swallowed `.catch` — so a new TS-only `"audit"` value would compile, render
 * on the live feed, and never reach the table. The shape is distinguished by
 * the text and by `metadata.audit` instead.
 *
 * **It is gated to `entra`, and that gate is LIVE.** On a `local` instance
 * there is one human, so every row would be the operator auditing themselves on
 * their own feed — noise that makes the real thing unfindable the day there is
 * one. It was written while `entra` could not boot and was therefore inert;
 * PR 2 flipped `AUTH_ZONES_IMPLEMENTED`, so on an `entra` instance these rows
 * are now WRITTEN — every admin passthrough and every unfiltered collection
 * read a NAV admin makes lands in `activity_log` as a `system` row carrying
 * `metadata.audit`. Nothing about the code changed; what changed is that the
 * mode it waits for is reachable.
 */
import { activityLog } from "../observability/activity-log.ts";
import { getLog } from "../logging.ts";
import type { AuthMode } from "./mode.ts";

const log = getLog("auth", "audit");

/**
 * One row per (reader, route) per window for the COLLECTION shape.
 *
 * `/api/traces` is polled every 15 s by every open `/traces` tab, so an
 * unbounded row per request would bury the feed and the table alike. The
 * per-request line stays on LogTape, which is bounded by its own warn-once and
 * by log rotation.
 */
export const AUDIT_DEDUP_WINDOW_MS = 5 * 60_000;

const lastCollectionRow = new Map<string, number>();
const lastPassthroughRow = new Map<string, number>();

/** Test-only: forget the dedup memory (the `__resetAuthWarningsForTest` idiom). */
export function __resetAuditDedupForTest(): void {
  lastCollectionRow.clear();
  lastPassthroughRow.clear();
}

function auditingEnabled(mode: AuthMode): boolean {
  return mode === "entra";
}

export interface PassthroughAudit {
  readonly mode: AuthMode;
  readonly reader: string;
  readonly owner: string;
  readonly path: string;
  /** `"claimed-id"` for `requireOwnUser`, else the resource kind. */
  readonly kind: string;
  /** Injected so the dedup window is testable without a clock. */
  readonly now?: number;
}

/**
 * An admin read a row belonging to someone else, through a guard that let them.
 * Deduped per (reader, kind, resource) — the `path` carries the resource id for
 * an id-addressed route, so the key collapses a poller's repeated reads of the
 * SAME row while keeping a read of a DIFFERENT row (or by a different reader) its
 * own fact. Returns whether a row was written, so a test can assert the gate.
 */
export function auditAdminPassthrough(a: PassthroughAudit): boolean {
  if (!auditingEnabled(a.mode)) return false;
  const now = a.now ?? Date.now();
  // \u0000 separators, spelled as escapes for the same reason
  // `auditAdminCollectionRead` gives: a raw NUL makes git treat the file as
  // binary. `kind` and `path` both ride the key: `path` is the concrete request
  // path (it carries the resource id), and `kind` keeps two kinds that could
  // share a path distinct.
  const key = `${a.reader}\u0000${a.kind}\u0000${a.path}`;
  const last = lastPassthroughRow.get(key);
  if (last !== undefined && now - last < AUDIT_DEDUP_WINDOW_MS) return false;
  lastPassthroughRow.set(key, now);
  activityLog.push(
    "system",
    `admin ${a.reader} read ${a.kind} owned by ${a.owner} on ${a.path}`,
    {
      userId: a.reader,
      metadata: { audit: "admin-passthrough", reader: a.reader, owner: a.owner, route: a.path, kind: a.kind },
    },
  );
  return true;
}

export interface CollectionAudit {
  readonly mode: AuthMode;
  readonly reader: string;
  readonly path: string;
  /** Injected so the dedup window is testable without a clock. */
  readonly now?: number;
}

/**
 * An admin read one of the unfiltered collections. Deduped per (reader, route);
 * returns whether a row was written this time.
 */
export function auditAdminCollectionRead(a: CollectionAudit): boolean {
  if (!auditingEnabled(a.mode)) return false;
  const now = a.now ?? Date.now();
  // `\u0000` as the separator, spelled as an ESCAPE — a raw NUL byte in a
  // source file makes git treat it as binary and the diff unreviewable
  // (measured on the first cut of this file). A space would be ambiguous:
  // a `users.id` may contain one, a path may not.
  const key = `${a.reader}\u0000${a.path}`;
  const last = lastCollectionRow.get(key);
  if (last !== undefined && now - last < AUDIT_DEDUP_WINDOW_MS) return false;
  lastCollectionRow.set(key, now);
  activityLog.push(
    "system",
    `admin ${a.reader} read the unfiltered collection ${a.path}`,
    {
      userId: a.reader,
      metadata: { audit: "admin-collection-read", reader: a.reader, route: a.path },
    },
  );
  log.info("Admin {reader} read the unfiltered collection {route}", { reader: a.reader, route: a.path });
  return true;
}
