/**
 * `/plans` — the read-only board over mimir's `plans/`, priced from the
 * claude-usage ledger, plus the JSON the page is rendered from.
 *
 * `GET /plans` embeds the payload inline and `GET /api/plans/board` serves the
 * SAME object, so a client can refresh without a reload and an operator can
 * diff what the page shows against what the assembly produced. Both go through
 * {@link assemblePlanBoard}; there is no second assembly path.
 *
 * **Neither route may 5xx.** Every degraded input on either side — mimir not
 * registered on this host, an unreachable or failed-rebuild ledger, a corpus
 * full of unparseable files — is a board STATE, rendered with a banner naming
 * the base URL it tried. A 500 here would take out the board for a plan file
 * with a broken frontmatter fence.
 *
 * The base URL idiom is `claude-usage-routes.ts`'s, on purpose: `config` reports
 * only whether the operator set `CLAUDE_USAGE_URL` (null ⇒ unset), and the
 * default is applied at this layer, where `urlConfigured` is derived from that
 * one fact.
 *
 * The two GETs never write. The two POSTs (PR 4) do, and both go through the
 * shared wiki write machinery rather than around it:
 *
 *   - `POST /api/plans/priority` edits one plan's frontmatter through
 *     `writeWikiPage` — readonly refusal, path confinement, per-wiki queue and
 *     `baseHash` CAS, in NO-LOG mode (a triage sitting is a burst of clicks, and
 *     a priority flip is metadata: no `log.md` line, no reindex).
 *   - `POST /api/plans/order` writes `plans/queue.yaml` through `writePlanQueue`
 *     (`src/plans/write.ts`), which `writeWikiPage` cannot carry — its path
 *     confinement admits `.md`/`.mdx` only.
 *
 * **Neither passes a `commit`.** mimir is in the repo-sync loop in `wiki` mode;
 * the sync loop is the committer, behind its 5-minute quiet period.
 *
 * ── The wire contract PR 5's client is written against ───────────────────────
 *
 *   - **`/priority`** answers `{slug, priority, hash, written, relPath}`.
 *     `priority` and `hash` are what is ON DISK, never what was asked for: a
 *     `noop` (same value re-set, clear on a plan carrying none) echoes the
 *     unchanged pair, which the CAS just proved. A fence the transform must not
 *     edit is a **422**, not a 200 with `written: false` — a refusal and "nothing
 *     to do" are different sentences to a reader whose click did nothing. NB the
 *     422 is currently unreachable over HTTP and is kept as a fail-closed
 *     backstop: the transform now draws the fence with `parseFrontmatter`'s own
 *     rule, so any file the board renders as a card is a file it can edit. It
 *     becomes reachable again the moment those two rules drift — which is
 *     exactly when a silent 200 would be worst.
 *   - **`/order`** answers `{order, hash, written, deleted, warnings}`, where
 *     `order` is the MERGED result on disk. A POST carries only the columns the
 *     reader touched: a posted column replaces that column, a posted `[]`
 *     un-ranks it, and an absent column is preserved — a wholesale replace
 *     silently un-ranked every omitted column. The merge runs INSIDE the CAS
 *     section, and it parses the current file with the SAME corpus slug set the
 *     board reads with, so a preserved column is filtered exactly as the board
 *     filters it (without that, a slug naming no plan on disk survived into the
 *     file and into this response while the board payload omitted it). The file
 *     is deleted only when the MERGE comes out empty; a body posting no columns
 *     at all is a 400, because "delete every ordering" must be an instruction
 *     somebody wrote, not the residue of a body that parsed to nothing.
 *     `written` is "bytes were written", `deleted` is "the file is gone", and a
 *     state change is `written || deleted` — never both true.
 *
 *     **How a malformed current file is handled is a two-way split, decided
 *     here.** A WHOLESALE parse failure (a YAML syntax error, a top level that
 *     is not a mapping) is a **422** naming the problem, and nothing is written:
 *     that parse degrades the entire document to "no column is ranked", which is
 *     the right read for the board but destroys every hand-written line the
 *     moment a merge writes it back. A PER-ENTRY drop (off-grammar slug, unknown
 *     column, duplicate, a slug naming no plan) is the file's documented
 *     read-time GC and stays MERGEABLE — refusing those would let one stale line
 *     block every drag — but the merge makes each drop durable, so every drop
 *     rides out on `warnings` rather than happening silently. `warnings` is
 *     always present and usually empty.
 *   - Both: 403 readonly · 404 unregistered wiki / unknown slug · 409 stale ·
 *     413 over `PLAN_BODY_MAX_BYTES` · **422 a refusal that names a file a human
 *     must fix by hand** · **503 when the source read failed**, naming the
 *     reason the GET path's banner would have named.
 *
 * **Both return the NEW sha256 in the 200 body, taken from the string that was
 * written** — never from a re-read after the write section released, which would
 * hand back a concurrent writer's bytes and arm the next edit to overwrite them.
 * Without it the second edit on one card 409s: the board captured its CAS once,
 * at render.
 */

import type { Context, Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { CLAUDE_USAGE_DEFAULT_URL } from "../claude-usage-overview.ts";
import { buildBoardPayload, type BoardPayload } from "../../plans/board.ts";
import {
  defaultPlanLedgerDeps,
  fetchPlanLedger,
  type PlanLedgerDeps,
  type PlanLedgerResult,
} from "../../plans/ledger.ts";
import {
  loadPlanSource,
  PLANS_WIKI_NAME,
  PLAN_PRIORITIES,
  type PlanPriority,
  type PlanSourceResult,
} from "../../plans/source.ts";
import { setPlanPriority } from "../../plans/frontmatter.ts";
import { writePlanQueue } from "../../plans/write.ts";
import {
  QUEUE_COLUMNS,
  mergeQueueOrder,
  parseQueueYaml,
  serializeQueue,
  type QueueColumn,
  type QueueOrder,
} from "../../plans/queue.ts";
import { defaultPageWriteIo, writeWikiPage } from "../../wiki/page-write.ts";
import { sha256 } from "../../gardener/util.ts";
import { readonlyRefusal } from "./route-utils.ts";
import { renderPlansPage } from "../views/plans-page.ts";

const log = getLog("dashboard", "plans");

/** Injectable seam: the tests drive the whole route without a mimir checkout
 *  and without a live claude-usage. `renderPage` is a seam too, so the "a page
 *  render that throws is still a 200" contract can be driven without breaking
 *  the bundler. */
export interface PlanBoardDeps {
  ledger: PlanLedgerDeps;
  loadSource: () => Promise<PlanSourceResult>;
  renderPage?: (payload: BoardPayload) => Promise<string>;
}

export function defaultPlanBoardDeps(config: Config): PlanBoardDeps {
  return {
    ledger: defaultPlanLedgerDeps(
      config.claudeUsageUrl ?? CLAUDE_USAGE_DEFAULT_URL,
      config.claudeUsageUrl != null,
    ),
    loadSource: () => loadPlanSource(),
  };
}

/** Warn-once per distinct source failure. `/plans` is polled by every open tab,
 *  and a mimir checkout that has gone missing writes the same line forever —
 *  the ledger card's `warnedX` idiom, for the same reason. Cleared wholesale
 *  past a sane size (same 100 as `warnedClaudeUsageErrors`) so a message
 *  carrying a varying detail — a path, an errno, a file name — cannot leak. */
const warnedSourceErrors = new Set<string>();

function warnSourceOnce(message: string): void {
  if (warnedSourceErrors.has(message)) {
    log.info("plan board: reading mimir's plans failed: {error}", { error: message });
    return;
  }
  if (warnedSourceErrors.size > 100) warnedSourceErrors.clear();
  warnedSourceErrors.add(message);
  log.error("plan board: reading mimir's plans failed: {error}", { error: message });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An empty corpus carrying the reason it is empty — the shape an unexpected
 *  filesystem failure degrades to, so the page still renders its columns. */
function failedSource(err: unknown): PlanSourceResult {
  return {
    root: null,
    plans: [],
    queue: { order: {}, hash: null },
    warnings: [`reading mimir's plans failed: ${err instanceof Error ? err.message : String(err)}`],
  };
}

/** The ledger side's own degrade, for the one case `fetchPlanLedger` cannot
 *  report itself: it threw. Same shape a refused payload produces. */
function failedLedger(deps: PlanBoardDeps, now: number, err: unknown): PlanLedgerResult {
  return {
    fetchedAt: now,
    baseUrl: deps.ledger.baseUrl,
    urlConfigured: deps.ledger.urlConfigured,
    ledgerConfigured: null,
    reachable: false,
    generatedAt: null,
    refreshedAt: null,
    plans: [],
    errors: [`reading the claude-usage ledger failed: ${errText(err)}`],
  };
}

/**
 * Read both sides in parallel and join them. The two reads are independent —
 * a dead ledger must not delay the wiki read, and neither may take the board
 * down — so they are genuinely SETTLED: `fetchPlanLedger` is written not to
 * reject, but "the comment says settled" is not the same as settled, and a
 * rejection on that arm would take out a board whose wiki read was fine.
 */
export async function assemblePlanBoard(
  deps: PlanBoardDeps,
  now: number = Date.now(),
): Promise<BoardPayload> {
  const [source, ledger] = await Promise.allSettled([
    deps.loadSource(),
    fetchPlanLedger(deps.ledger, now) as Promise<PlanLedgerResult>,
  ]);

  let sourceResult: PlanSourceResult;
  if (source.status === "fulfilled") {
    sourceResult = source.value;
  } else {
    warnSourceOnce(errText(source.reason));
    sourceResult = failedSource(source.reason);
  }

  let ledgerResult: PlanLedgerResult;
  if (ledger.status === "fulfilled") {
    ledgerResult = ledger.value;
  } else {
    log.error("plan board: the ledger read threw: {error}", { error: errText(ledger.reason) });
    ledgerResult = failedLedger(deps, now, ledger.reason);
  }

  return buildBoardPayload({ source: sourceResult, ledger: ledgerResult, now });
}

/**
 * The last resort: the whole assembly threw before it could produce a payload
 * (a dep that fails on access, a bug in the join). Neither route may 5xx, so
 * this is the state they degrade to — a board with no cards that SAYS why, in
 * the `warnings` the page already renders as a banner.
 */
function failedPayload(deps: PlanBoardDeps, now: number, err: unknown): BoardPayload {
  return buildBoardPayload({
    source: failedSource(err),
    ledger: failedLedger(deps, now, err),
    now,
  });
}

export function registerPlansRoutes(
  app: Hono,
  config: Config,
  deps: PlanBoardDeps = defaultPlanBoardDeps(config),
): void {
  const render = deps.renderPage ?? renderPlansPage;

  app.get("/plans", async (c) => {
    // TWO throwing surfaces, and the handler owns both: the assembly (which is
    // defensive per-input but can still fail whole) and the RENDER — a bundle
    // build failure is exactly the state where an unexplained Hono 500 is the
    // least useful thing the page could do.
    let payload: BoardPayload;
    try {
      payload = await assemblePlanBoard(deps);
    } catch (err) {
      log.error("plan board: assembling /plans failed: {error}", { error: errText(err) });
      payload = failedPayload(deps, Date.now(), err);
    }
    try {
      return c.html(await render(payload));
    } catch (err) {
      log.error("plan board: rendering /plans failed: {error}", { error: errText(err) });
      return c.html(renderPlansFallback(errText(err)), 200);
    }
  });

  app.get("/api/plans/board", async (c) => {
    try {
      return c.json(await assemblePlanBoard(deps));
    } catch (err) {
      log.error("plan board: assembling the board payload failed: {error}", { error: errText(err) });
      const payload = failedPayload(deps, Date.now(), err);
      return c.json({ ...payload, errors: payload.warnings });
    }
  });

  // ---- writes -------------------------------------------------------------

  app.post("/api/plans/priority", async (c) => {
    const refusal = readonlyRefusal(c, log);
    if (refusal) return refusal;
    try {
      const read = await readJsonBody(c);
      if ("error" in read) return c.json({ error: read.error }, read.status);
      const body = read.body;

      const slug = typeof body.slug === "string" ? body.slug.trim() : "";
      if (!slug) return c.json({ error: "slug is required" }, 400);
      // The enum runs BEFORE the transform, and an omitted or null `priority` is
      // a 400 rather than a clear: clearing has exactly one wire form, `"clear"`.
      // An absent field is what a buggy client sends, and an accidental clear
      // turns a fail-closed guard into silent data loss.
      const wanted = body.priority;
      if (!isPriorityInput(wanted)) {
        return c.json(
          { error: `priority must be one of ${PLAN_PRIORITIES.join(", ")} or "clear"` },
          400,
        );
      }
      const priority: PlanPriority | null = wanted === "clear" ? null : wanted;
      const baseHash = typeof body.baseHash === "string" ? body.baseHash.trim() : "";
      if (!baseHash) return c.json({ error: "baseHash is required" }, 400);

      const loaded = await loadSourceOrDegrade(deps);
      if ("error" in loaded) return c.json({ error: loaded.error }, 503);
      const source = loaded.source;
      const root = source.root;
      if (!root) return c.json({ error: unregisteredMessage() }, 404);
      const plan = source.plans.find((p) => p.slug === slug);
      if (!plan) return c.json({ error: `no plan named "${slug}"` }, 404);

      // The transform's own return value is what gets hashed — stashed here
      // rather than re-read afterwards (see the module doc). A REFUSAL comes
      // back the same way: `writeWikiPage`'s `transform` seam speaks `null` for
      // "nothing to do", so the reason rides out on a closure variable rather
      // than widening a contract three other writers share.
      let written: string | null = null;
      let refused: string | null = null;
      const result = await writeWikiPage({
        wikiDir: root,
        relPath: plan.relPath,
        baseHash,
        staleReason: `${plan.relPath} changed since the board was loaded`,
        // No-log mode skips the reindex fan-out anyway; `[]` says the same thing
        // where the call is read.
        collections: [],
        logKind: null,
        now: () => Date.now(),
        transform: (raw) => {
          const edit = setPlanPriority(raw, priority);
          refused = edit.kind === "refused" ? edit.reason : null;
          written = edit.kind === "changed" ? edit.content : null;
          return written;
        },
        ...defaultPageWriteIo(root),
        // The board reads `loadPlanSource` off disk, not the wiki index, so a
        // rebuild buys this route nothing — and it is not free: measured
        // 110–140 ms over mimir's 449 pages (2026-08-18), on a surface whose
        // unit of work is a triage click. The seam stays wired so a later caller
        // that DOES read the index can put the rebuild back.
        refreshIndex: async () => {},
        reindex: async () => {},
      });

      if (refused) {
        log.warn("plan priority: refused {slug}: {reason}", { slug, reason: refused });
        return c.json({ error: refused }, 422);
      }
      if (result.outcome === "forbidden") {
        return c.json({ error: result.reason, readonly: true }, 403);
      }
      if (result.outcome === "stale") {
        return c.json({ error: result.reason, stale: true }, 409);
      }
      if (result.outcome === "error") {
        log.error("plan priority: write failed for {slug}: {error}", { slug, error: result.reason });
        return c.json({ error: result.reason }, 500);
      }
      // A `noop` is an HONEST one — the same value already set, or a clear on a
      // plan carrying none; a fence this must not edit took the 422 above. It
      // echoes the UNCHANGED hash, which the CAS just proved is what is on disk,
      // and the priority ON DISK rather than the requested one: a 200 must never
      // tell the board a value is in the file that is not.
      const changed = result.outcome === "written" && written !== null;
      return c.json({
        slug,
        priority: changed ? priority : plan.priority ?? null,
        hash: changed ? sha256(written!) : baseHash,
        written: changed,
        relPath: plan.relPath,
      });
    } catch (err) {
      log.error("plan priority: unexpected failure: {error}", { error: errText(err) });
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.post("/api/plans/order", async (c) => {
    const refusal = readonlyRefusal(c, log);
    if (refusal) return refusal;
    try {
      const read = await readJsonBody(c);
      if ("error" in read) return c.json({ error: read.error }, read.status);
      const body = read.body;

      // `""` is a legal base (the file is absent) — so the check is on the TYPE,
      // never on truthiness, or the bootstrap write could never be made.
      if (typeof body.baseHash !== "string") {
        return c.json({ error: "baseHash is required (\"\" when queue.yaml does not exist yet)" }, 400);
      }
      const baseHash = body.baseHash;
      const parsed = parseOrderBody(body.order);
      if ("error" in parsed) return c.json({ error: parsed.error }, 400);

      const loaded = await loadSourceOrDegrade(deps);
      if ("error" in loaded) return c.json({ error: loaded.error }, 503);
      const source = loaded.source;
      const root = source.root;
      if (!root) return c.json({ error: unregisteredMessage() }, 404);

      // The client only ever sends slugs it rendered, so an unknown one is a
      // stale client — refused rather than written as a rank for nothing.
      const known = new Set(source.plans.map((p) => p.slug));
      for (const slugs of Object.values(parsed.order)) {
        for (const slug of slugs ?? []) {
          if (!known.has(slug)) return c.json({ error: `no plan named "${slug}"` }, 400);
        }
      }
      // Fail on the POSTED slugs before the write section opens, so a bad slug
      // costs no queue turn; the merged order is serialized inside it, where the
      // same throw is a 500-worthy surprise rather than a client error.
      try {
        serializeQueue(parsed.order);
      } catch (err) {
        // `serializeQueue` throws on a slug outside the grammar mimir's own
        // parser shares — bytes that would take its every column down.
        return c.json({ error: errText(err) }, 400);
      }

      // The MERGE happens inside the CAS section, over the bytes the compare
      // just validated: a POST carries the columns the reader touched, and a
      // wholesale replace un-ranked every column it omitted (proven: posting
      // `{ready:[…]}` over a file that also ranked `blocked` deleted `blocked`,
      // 200). Merging outside the section would read a file the write may not be
      // the next writer of.
      //
      // Two things ride out of the section on closure variables, the `refused`
      // idiom the priority route above uses: `buildContent` must return bytes,
      // so a refusal cannot be its return value.
      let mergedOrder: QueueOrder = parsed.order;
      let refusal: string | null = null;
      let warnings: string[] = [];
      const result = await writePlanQueue({
        wikiDir: root,
        baseHash,
        buildContent: (current) => {
          // Parsed with the SAME corpus slug set the board reads with, so a
          // preserved column is filtered exactly as `/api/plans/board` filters
          // it. Without it a slug naming no plan survived the merge into both
          // the file and the response's `order`, while the board payload omitted
          // it — leaving PR 5's client holding a rank for a card it never draws.
          const disk = current === null ? { order: {}, warnings: [] } : parseQueueYaml(current, known);
          if (disk.unparseable) {
            // REFUSE. The parse degraded the whole document to "nothing is
            // ranked", which is right for a reader (the board still renders) and
            // catastrophic for a read-modify-write: merging over it writes the
            // degradation to disk. Proven live — one `- [ unclosed` line and the
            // OTHER column's hand-written ranking was gone on a 200.
            refusal = disk.unparseable;
            throw new Error(refusal);
          }
          // Per-entry drops (off-grammar slug, unknown column, duplicate, a slug
          // naming no plan) stay MERGEABLE — that is the file's documented
          // read-time GC, and refusing them would make one stale line block
          // every drag. But the merge makes each drop DURABLE, so they are
          // announced on the response instead of vanishing quietly.
          warnings = disk.warnings;
          mergedOrder = mergeQueueOrder(disk.order, parsed.order, parsed.columns);
          return serializeQueue(mergedOrder);
        },
      });
      if (refusal) {
        log.warn("plan order: refused the write: {reason}", { reason: refusal });
        return c.json({ error: refusal }, 422);
      }
      if (result.outcome === "forbidden") {
        return c.json({ error: result.reason, readonly: true }, 403);
      }
      if (result.outcome === "stale") {
        return c.json({ error: result.reason, stale: true }, 409);
      }
      if (result.outcome === "error") {
        log.error("plan order: write failed: {error}", { error: result.reason });
        return c.json({ error: result.reason }, 500);
      }
      // `written` is "bytes were written", `deleted` is "the file is gone" — a
      // state change is `written || deleted`, and the two are never both true.
      return c.json({
        order: mergedOrder,
        hash: result.hash,
        written: result.outcome === "written",
        deleted: result.outcome === "deleted",
        warnings,
      });
    } catch (err) {
      log.error("plan order: unexpected failure: {error}", { error: errText(err) });
      return c.json({ error: "internal error" }, 500);
    }
  });
}

/**
 * The largest body either write route will read. Both are machine-generated by
 * the board — one slug and a hash, or a few hundred ranked slugs — so this is
 * three orders of magnitude of headroom, and it exists because neither route
 * should buffer whatever a loopback client happens to send.
 *
 * **It refuses a DECLARED oversize before the read, and an undeclared one
 * after.** A body carrying a `content-length` over the cap never reaches
 * `c.req.text()`; a chunked body declares no length, so it is fully buffered and
 * then measured. That second case is a cap on what is ACCEPTED, not on what is
 * held in memory — accepted deliberately, because both routes are loopback-only
 * (`DASHBOARD_HOST` defaults to 127.0.0.1) and a stream-limited read would buy
 * nothing an attacker on that surface could not already do.
 */
const PLAN_BODY_MAX_BYTES = 256 * 1024;

/**
 * The posted JSON, or the status to answer with.
 *
 * Anything that is not a plain object — `null` (which `c.req.json()` resolves
 * happily, and whose first `typeof body.x` access threw a 500), an array, a bare
 * scalar, unparseable bytes — normalizes to `{}`, so it takes the routes'
 * ordinary "slug is required" / "baseHash is required" 400s instead of an
 * internal error naming nothing.
 */
async function readJsonBody(
  c: Context,
): Promise<{ body: Record<string, unknown> } | { error: string; status: 400 | 413 }> {
  const overLimit = {
    error: `request body is larger than the ${PLAN_BODY_MAX_BYTES}-byte limit`,
    status: 413 as const,
  };
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > PLAN_BODY_MAX_BYTES) return overLimit;

  const text = await c.req.text().catch(() => "");
  if (Buffer.byteLength(text) > PLAN_BODY_MAX_BYTES) return overLimit;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: {} };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { body: {} };
  return { body: parsed as Record<string, unknown> };
}

/**
 * The write routes' source read, degraded the way the GET path degrades: a
 * failure names its reason instead of arriving as an opaque 500 that says only
 * "internal error" about a checkout that has gone missing.
 */
async function loadSourceOrDegrade(
  deps: PlanBoardDeps,
): Promise<{ source: PlanSourceResult } | { error: string }> {
  try {
    return { source: await deps.loadSource() };
  } catch (err) {
    const message = `reading mimir's plans failed: ${errText(err)}`;
    warnSourceOnce(message);
    return { error: message };
  }
}

function unregisteredMessage(): string {
  return `wiki "${PLANS_WIKI_NAME}" is not registered on this host — set WIKI_EXTRA=${PLANS_WIKI_NAME}=<path>`;
}

/** `"clear"` is the ONE wire form for clearing — see the route's comment. */
function isPriorityInput(v: unknown): v is PlanPriority | "clear" {
  return typeof v === "string" && (v === "clear" || (PLAN_PRIORITIES as readonly string[]).includes(v));
}

/**
 * Validate the posted `order` into the shape `serializeQueue` takes. Every
 * rejection is a 400: the ranking is machine-generated by the board, so an
 * off-shape body is a bug in a client, not a state to accommodate.
 *
 * A slug placed in two columns (or twice in one) is refused rather than written:
 * `parseQueueYaml` DROPS the later copy on the way back in, so those bytes would
 * read back as a different ordering than the one that was saved.
 *
 * **`columns` is the posted KEY SET, and it is not derivable from `order`.**
 * Rule 2 of the grammar says an empty column has no key, so a posted `[]` —
 * which is how a reader un-ranks a column — leaves no trace in `order`. The
 * writer needs the difference: a column that was posted empty is CLEARED, a
 * column that was not posted at all is preserved from disk.
 *
 * That gap is also why a body carrying NO column at all is refused here.
 * Reducing to `{}` meant "no columns ranked", which the writer implements by
 * DELETING the file — so an empty body erased every column's ordering and
 * answered 200. Every other off-shape key already returns above (a key that is
 * not a column name is an unknown-column 400, which is also where a
 * `{"__proto__": […]}` body lands), so `columns.length === 0` is the whole
 * check: a key-set comparison against `Object.entries` could never fire.
 */
function parseOrderBody(
  raw: unknown,
): { order: QueueOrder; columns: QueueColumn[] } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "order must be an object of column → slugs" };
  }
  const order: QueueOrder = {};
  const columns: QueueColumn[] = [];
  const placed = new Set<string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(QUEUE_COLUMNS as readonly string[]).includes(key)) {
      return { error: `unknown column "${key}" — expected one of ${QUEUE_COLUMNS.join(", ")}` };
    }
    if (!Array.isArray(value)) return { error: `column "${key}" must be an array of slugs` };
    const slugs: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || !entry.trim()) {
        return { error: `column "${key}" has a non-slug entry` };
      }
      const slug = entry.trim();
      if (placed.has(slug)) return { error: `"${slug}" is ranked more than once` };
      placed.add(slug);
      slugs.push(slug);
    }
    columns.push(key as QueueColumn);
    // Rule 2 of the grammar: an emptied column leaves no key behind.
    if (slugs.length > 0) order[key as QueueColumn] = slugs;
  }
  if (columns.length === 0) {
    return { error: "no columns posted — send the columns to rank, `[]` to un-rank one" };
  }
  return { order, columns };
}

/** The page the page degrades to: no styling, no bundle, one sentence naming
 *  the failure and the endpoint that still works. */
function renderPlansFallback(message: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Muninn - Plans</title></head>
<body>
  <h1>Plan board</h1>
  <p>The board could not be rendered: <code>${esc(message)}</code></p>
  <p>The payload itself is still served by <code>GET /api/plans/board</code>.</p>
</body></html>`;
}
