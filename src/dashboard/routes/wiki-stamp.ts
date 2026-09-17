/**
 * `POST /api/wiki/provenance/stamp` — record a session on a wiki page's
 * `sessions:` line.
 *
 * **muninn writes no frontmatter line here.** There is exactly ONE line-upsert
 * implementation and it lives in claude-usage (`src/wiki-stamp.ts`, driven by
 * `scripts/wiki-stamp.ts`); the Claude Code `PostToolUse` hook and the opencode
 * plugin call it today, and this route is its third caller. Two writers of one
 * frontmatter line lose each other's appends, which is what the cross-process
 * lockfile (`src/wiki/lockfile.ts`, which the CLI takes too) exists to prevent —
 * and a second implementation here would be exactly that second writer.
 *
 * So the spawn is the HOOK'S OWN command line plus `--report`:
 *
 *     <WIKI_STAMP_BUN|bun> <WIKI_STAMP_BIN> --session <ref> --file <abs> --report
 *
 * with `WIKI_STAMP_ROOTS` handed down in the child environment. `--report` is
 * the CLI's answer channel: ONE JSON line on stdout, last. Without it the CLI
 * prints nothing and always exits 0 (its own banner invariant), so the exit code
 * is information HERE only when there is no report line at all.
 *
 * ── The checks, in order, each before any spawn ──────────────────────────────
 *  1. `relPath` through `isPathConfined` — the exact form `writeWikiPage` uses,
 *     `existingRelPath` included, because without it the helper refuses every
 *     page outside `expectedDir(domain, kind)`, which is nearly every page a
 *     reader has open. Outside the root ⇒ 400.
 *  2. `isWikiReadonly()` / `isReadonlyWikiRoot()` ⇒ 403. AFTER the confinement,
 *     unlike `writeWikiPage` (which checks read-only first): deliberate, so a
 *     traversal never reaches the read-only test with an unresolved root.
 *  3. `WIKI_STAMP_BIN` / `WIKI_STAMP_ROOTS` unset ⇒ 501 naming the variable.
 *     Below the 403, because an instance that must not write is unwritable
 *     however it is configured.
 *
 * ── Zones and CSRF ──────────────────────────────────────────────────────────
 * The route is ADMIN-ZONE by muninn's default-deny — it has no `zones.ts` entry,
 * which is what "admin only" is spelled as — and it is a POST, so the global
 * side-effect check in `auth/origin.ts` covers it. Stated here so a reviewer can
 * see it was decided rather than missed.
 *
 * **No `baseHash` crosses the wire.** The append is idempotent (`already-stamped`
 * is an `unchanged` report) and the CLI holds the same per-root lock muninn's own
 * writers take across its whole read-modify-write, so there is nothing for a hash
 * to protect. That is only true while `stampable` is EQUALITY on the wiki root —
 * see `stamp-roots.ts`.
 */

import type { Hono } from "hono";
import path from "node:path";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { isPathConfined } from "../../gardener/draft.ts";
import {
  isReadonlyWikiRoot,
  isWikiReadonly,
  wikiReadonlyRootReason,
  WIKI_READONLY_REASON,
} from "../../wiki/readonly.ts";
import {
  stampConfigFromEnv,
  WIKI_STAMP_BIN_ENV,
  WIKI_STAMP_ROOTS_ENV,
  WIKI_STAMP_TIMEOUT_MS,
  type StampConfig,
} from "../../wiki/stamp-roots.ts";
import { pageProvenance, type ProvenanceContext } from "../../wiki/provenance-service.ts";
import { runProc } from "../../utils/run-proc.ts";
import { getLog } from "../../logging.ts";

const log = getLog("wiki", "stamp");

/** The route's seams. Every one of them is read at REQUEST time — an operator
 *  can set the variables without a restart, and a test drives the CLI without
 *  the environment. */
export interface StampRouteDeps {
  stampConfig?: () => StampConfig;
  isReadonly?: () => boolean;
  isReadonlyRoot?: (root: string) => boolean;
  runProc?: typeof runProc;
  timeoutMs?: number;
}

/** What the CLI's `--report` line says. */
interface StampReport {
  outcome: "written" | "unchanged" | "skipped";
  reason?: string;
  path?: string;
}

/**
 * The LAST stdout line, parsed as the report, or null.
 *
 * Last rather than first: `WIKI_STAMP_BIN` is a `.ts` source run through an
 * interpreter, and an interpreter is free to print a warning of its own before
 * the program does. Anything that is not a JSON object with a known `outcome` is
 * not a report — a 502 saying "the CLI answered nothing I can read" is the
 * honest outcome, and guessing from the exit code is how a silent failure
 * becomes a green Stamp.
 */
function parseReport(stdout: string): StampReport | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const outcome = (parsed as { outcome?: unknown }).outcome;
    if (outcome !== "written" && outcome !== "unchanged" && outcome !== "skipped") continue;
    const reason = (parsed as { reason?: unknown }).reason;
    return { outcome, ...(typeof reason === "string" && reason ? { reason } : {}) };
  }
  return null;
}

/** The first line of stderr — enough to say WHICH failure, without shipping a
 *  stack trace onto a reader's page. */
function firstLine(stderr: string): string {
  return stderr.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

export function registerWikiStampRoute(
  app: Hono,
  ctx: ProvenanceContext,
  deps: StampRouteDeps = {},
): void {
  app.post("/api/wiki/provenance/stamp", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      wiki?: unknown;
      relPath?: unknown;
      ref?: unknown;
    } | null;
    const wiki = typeof body?.wiki === "string" ? body.wiki.trim() : "";
    const relPath = typeof body?.relPath === "string" ? body.relPath.trim() : "";
    const ref = typeof body?.ref === "string" ? body.ref.trim() : "";
    if (!relPath || !ref) {
      return c.json({ error: "relPath and ref are required" }, 400);
    }

    // The SAME resolution every other `/api/wiki/*` route makes, so an omitted
    // `wiki` means the default wiki here too — which is what a reader browsing a
    // bare `/wiki` has to send, since the client holds no name for it.
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      wiki || undefined,
      undefined,
      process.env.WIKI_DIR,
    );
    if (unknownWiki || !entry) return c.json({ error: "no wiki configured for that name" }, 404);

    // 1. Confinement. The `existingRelPath` form: this route only ever stamps a
    //    page that already exists, so the "update" branch is the right one, and
    //    the create branch would refuse every page outside `ai/concepts/`.
    if (
      !isPathConfined({
        targetPath: relPath,
        wikiDir: entry.root,
        domain: "ai",
        kind: "concept",
        existingRelPath: relPath,
      })
    ) {
      return c.json({ error: `path confinement failed for "${relPath}"` }, 400);
    }

    // 2. Read-only, instance then root — the same two guards `writeWikiPage`
    //    takes, in the same order, refusing the same way.
    if ((deps.isReadonly ?? isWikiReadonly)()) {
      return c.json({ error: WIKI_READONLY_REASON }, 403);
    }
    if ((deps.isReadonlyRoot ?? isReadonlyWikiRoot)(entry.root)) {
      return c.json({ error: wikiReadonlyRootReason(entry.root) }, 403);
    }

    // 3. Is there a stamper at all?
    const config = (deps.stampConfig ?? stampConfigFromEnv)();
    if (!config.bin) {
      return c.json({ error: `${WIKI_STAMP_BIN_ENV} is not set on this instance` }, 501);
    }
    if (!config.rootsRaw) {
      return c.json({ error: `${WIKI_STAMP_ROOTS_ENV} is not set on this instance` }, 501);
    }

    const absPath = path.join(entry.root, relPath);
    let proc;
    try {
      proc = await (deps.runProc ?? runProc)(
        [config.bun, config.bin, "--session", ref, "--file", absPath, "--report"],
        deps.timeoutMs ?? WIKI_STAMP_TIMEOUT_MS,
        "wiki-stamp",
        // `{ ...process.env, … }`, never a bare object: `env` REPLACES the child
        // environment, and a child with no PATH cannot find the interpreter —
        // which lands every Stamp in the 502 bucket with an empty stderr.
        { env: { ...process.env, [WIKI_STAMP_ROOTS_ENV]: config.rootsRaw } },
      );
    } catch (err) {
      // The CLI bounds ITSELF at 5 s and reports `lock-timeout`/`deadline` from
      // inside that budget, so reaching muninn's own bound means it never got to
      // answer — a slow interpreter start or a wedged child.
      log.warn("wiki-stamp did not return: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "the stamp CLI did not return", reason: "stamp-timeout" }, 409);
    }

    const report = parseReport(proc.stdout);
    if (!report) {
      return c.json(
        {
          error: "the stamp CLI printed no report line",
          exitCode: proc.exitCode,
          stderr: firstLine(proc.stderr),
        },
        502,
      );
    }
    if (report.outcome === "skipped") {
      return c.json({ error: "the stamp was skipped", reason: report.reason ?? "skipped" }, 409);
    }

    // A WRITTEN report changed the frontmatter, and `pageProvenance` reads
    // `sessions:` off the TTL-cached index — so the refresh runs BEFORE the
    // re-resolve, exactly as `defaultPageWriteIo` does for muninn's own writes.
    // Without it the cache answers the pre-stamp list and the row stays amber:
    // the inert-fix shape, green in every test that does not open the page.
    if (report.outcome === "written") await getWikiIndex({ root: entry.root, refresh: true });
    const index = await getWikiIndex({ root: entry.root });
    const meta = index?.resolveRelPath(relPath);
    const provenance = meta ? await pageProvenance(meta, ctx, entry.root) : null;
    log.info("wiki-stamp {outcome} {ref} on {wiki}/{relPath}", {
      outcome: report.outcome,
      ref,
      wiki,
      relPath,
    });
    return c.json({ outcome: report.outcome, ...(provenance ? { provenance } : {}) });
  });
}
