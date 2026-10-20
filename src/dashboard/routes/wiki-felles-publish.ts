/**
 * `POST /api/wiki/felles-publish` — run the operator's `publiser-felles-wiki.ts`
 * on one page of an allowlisted wiki, or on the whole wiki's changed pages, dry
 * run or for real, and hand back what it printed. `GET /api/wiki/felles-status`
 * — the script's read-only `--status --json`, validated. See
 * `src/wiki/felles-publish.ts` for why muninn shells out rather than uploading
 * itself.
 *
 * POST body: `{ wiki, relPath, dryRun, allowIdent, action? }`. `action` is
 * `publish` (the default), `remove`, which runs the script's `--fjern` on the
 * page's object and the data files publish uploads for it (`felles-remove.ts`;
 * the answer adds `removes`, `dataFiles`, `keptShared` and `keptRefused`), or
 * `sync`, which runs `--synk` on the whole wiki and takes no relPath;
 * `allowIdent` is required for publish and sync. A real remove deletes the page
 * in one run (`pageRun`, read by `fellesFjernVerdict`) and the data files in a
 * second (`dataRun`, `dataFilesExitCode`) only when the page run deleted the
 * page (`deleted`). A page run that reads «not in the bucket» (`missing`) runs
 * no data delete: a page published under another name, such as this one
 * before a rename, may still show those files. `retryDataFiles` says whether
 * Retry data files may follow. `dataFilesOnly: true` is that retry: the
 * data-file run alone, admitted only on this process's own record that a page
 * run deleted the page within `FELLES_GONE_TTL_MS` (else 409 `page-not-gone`). The decision table is in `src/wiki/CLAUDE.md`. Answers 200
 * `{ exitCode, dryRun, output }` whenever the script ran — its exit code is the
 * verdict (0 ok, 1 a file refused, 2 usage/environment, 3 an upload or delete
 * failed) and its output is already masked by the script. Refusals before any spawn:
 * 415/403 (the stamp route's same-origin gate), 400 bad body, 501 not
 * configured, 403 a wiki not in `FELLES_WIKI_PUBLISH_WIKIS`, 404 no such page,
 * 409 while another run is in flight (one at a time per process; the three
 * actions share the slot).
 * The page must be one the wiki index lists. `fellesScriptArgs` builds the
 * argv from its index relPath (in NFC for remove) and keeps a dash-led page
 * from being read as a flag.
 * A `WIKI_READONLY_ROOTS` root is refused (403): publishing ships the page off
 * the machine, the same egress every other read-only check refuses.
 *
 * GET `?wiki=<name>[&allowIdent=0|1]` (header `x-muninn-felles: status`):
 * 200 `{ bucket, pages, orphans, maybeOrphans, changed, checkedAt }`
 * (`felles-status.ts`); 403 `cross-origin` or `missing-header` from its own
 * gate; 400 without a wiki or with an `allowIdent` other than 0 or 1; 502 when
 * the script failed or answered anything but the status shape; 504 on timeout;
 * and the same 501/403/404 as the POST. `allowIdent` (default 1, the dialogs'
 * default) is the script's `--tillat-ident`, which decides whether a page with
 * a NAVident counts as changed or refused. The status does NOT take the run
 * slot: it is read-only, and the reader asks for it while a long sync runs.
 *
 * Every spawn leads its own process group, so a timeout signals gcloud as well
 * as the script (`runProc`'s `processGroup`). On a timeout `runProc` sends the
 * group SIGTERM and rejects once the leader exits or after the grace plus the
 * post-kill wait; it SIGKILLs the group at once when the leader dies on the
 * SIGTERM, or when the grace runs out with the leader still there. It does not
 * wait for the other members, so the run slot can free while one still runs.
 */
import { existsSync } from "node:fs";
import type { Hono } from "hono";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest, type WikiRegistryEntry } from "../../wiki/registry.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { isReadonlyWikiRoot, wikiNoEgressReason } from "../../wiki/readonly.ts";
import {
  FELLES_PUBLISH_BIN_ENV,
  fellesPublishableFor,
  fellesPublishChildEnv,
  fellesPublishConfigFromEnv,
  fellesScriptArgs,
  type FellesAction,
  type FellesPublishConfig,
} from "../../wiki/felles-publish.ts";
import { parseFellesStatus, type FellesStatus } from "../../wiki/felles-status.ts";
import { fellesFjernVerdict, fellesRemoveDataFiles, type FellesFjernVerdict } from "../../wiki/felles-remove.ts";
import { decideStampRequest, originMatchesHost } from "./wiki-stamp.ts";
import { ProcTimeoutError, runProc } from "../../utils/run-proc.ts";
import { getLog } from "../../logging.ts";

const log = getLog("wiki", "felles-publish");

/** gcloud lists the bucket and uploads per file; a cold gcloud start alone
 *  measures several seconds. */
export const FELLES_PUBLISH_TIMEOUT_MS = 120_000;

/** A sync runs one `gcloud storage cp` per file, in sequence: 47 files for 9
 *  changed pages measured. 10 minutes gives each of ~50 uploads about 10 s (a
 *  cold gcloud start alone takes several) plus the bucket listing and scan. */
export const FELLES_SYNC_TIMEOUT_MS = 600_000;

/** How long a page run's evidence that the page is gone from the bucket
 *  admits Retry data files. A publish or sync on this process drops it at
 *  once; the TTL bounds a re-publish this process cannot see (the CLI, the
 *  other machine). */
export const FELLES_GONE_TTL_MS = 15 * 60_000;

/** One bucket listing plus a scan of the wiki's published pages. */
export const FELLES_STATUS_TIMEOUT_MS = 60_000;

/** How long a status answer is served from memory. Short, because local edits
 *  are half of what the status compares; a run through the POST drops it anyway. */
export const FELLES_STATUS_TTL_MS = 30_000;

/** The request header the reader's status fetch carries (value `status`). A
 *  cross-origin page cannot send it without a CORS preflight, which muninn never
 *  answers, so an `<img>`, a `no-cors` fetch or a link on a third-party page
 *  cannot make this instance spawn gcloud — even in a browser that sends no
 *  `Sec-Fetch-Site`. */
export const FELLES_STATUS_HEADER = "x-muninn-felles";

export interface FellesPublishRouteDeps {
  config?: () => FellesPublishConfig;
  runProc?: typeof runProc;
  timeoutMs?: number;
  syncTimeoutMs?: number;
  statusTimeoutMs?: number;
  statusTtlMs?: number;
  goneTtlMs?: number;
  now?: () => number;
  /** The interpreter argv before the script. Default: the running Bun with
   *  `--no-env-file`, without which Bun loads muninn's own `.env` from the
   *  working directory and undoes the environment allowlist. */
  interpreter?: string[];
}

/** The GET gate. `decideStampRequest` is the model, minus its content-type
 *  rule (a GET has no body): refuse what the browser marks cross-origin, refuse
 *  an `Origin` that is not this host, and require {@link FELLES_STATUS_HEADER}. */
export function decideFellesStatusRequest(req: {
  secFetchSite?: string | null;
  origin?: string | null;
  host?: string | null;
  marker?: string | null;
}): { status: 403; error: string; reason: string } | null {
  const site = (req.secFetchSite ?? "").trim().toLowerCase();
  const origin = (req.origin ?? "").trim();
  if (site === "cross-site" || site === "same-site" || (origin && !originMatchesHost(origin, req.host ?? ""))) {
    return { status: 403, error: "cross-origin request", reason: "cross-origin" };
  }
  if ((req.marker ?? "").trim() !== "status") {
    return { status: 403, error: `the ${FELLES_STATUS_HEADER}: status header is required`, reason: "missing-header" };
  }
  return null;
}

type StatusAnswer =
  | { http: 200; body: FellesStatus & { checkedAt: number } }
  | { http: 502 | 504; body: { error: string; reason: string } };

type Target =
  | { refusal: { status: 501 | 404 | 403; body: Record<string, unknown> } }
  | { refusal?: undefined; entry: WikiRegistryEntry; bin: string };

export function registerWikiFellesPublishRoute(app: Hono, deps: FellesPublishRouteDeps = {}): void {
  // One run at a time: every run targets the same bucket, and a dialog the
  // browser closed mid-run (Chrome makes a repeated Escape non-cancelable)
  // must not be able to start a second upload beside the first.
  let inFlight = false;
  const now = deps.now ?? Date.now;
  const interpreter = () => deps.interpreter ?? [process.execPath, "--no-env-file"];

  // The status cache, keyed by wiki name and `allowIdent`. `generation` moves
  // when a run that could have changed the bucket ends (spawned, not a dry run),
  // so a status spawned before that is neither cached nor joined by a later
  // request: it may have seen the bucket before the run changed it.
  // wiki + page (NFC) → when a real page run here last deleted the page
  // (`fellesFjernVerdict` `deleted`; `missing` is not enough, see the data run).
  // Retry data files needs it, so the retry cannot delete a published page's
  // data files.
  const goneEvidence = new Map<string, number>();
  let generation = 0;
  const statusCache = new Map<string, { at: number; gen: number; answer: StatusAnswer }>();
  const statusPending = new Map<string, { gen: number; promise: Promise<StatusAnswer> }>();
  const invalidateStatus = () => {
    generation++;
    statusCache.clear();
  };

  /** The checks both routes share once the wiki name is known. */
  function resolveTarget(wiki: string): Target {
    const config = (deps.config ?? fellesPublishConfigFromEnv)();
    if (!config.bin) return { refusal: { status: 501, body: { error: `${FELLES_PUBLISH_BIN_ENV} is not set on this instance` } } };
    const { entry, unknownWiki } = resolveWikiRequest(getWikiRegistry(), wiki, undefined, undefined);
    if (unknownWiki || !entry) return { refusal: { status: 404, body: { error: "no wiki configured for that name" } } };
    if (!fellesPublishableFor(entry.name, config)) {
      return {
        refusal: { status: 403, body: { error: "this wiki is not configured for felles publishing", reason: "not-a-publish-wiki" } },
      };
    }
    if (isReadonlyWikiRoot(entry.root)) {
      return { refusal: { status: 403, body: { error: wikiNoEgressReason(entry.name), readonly: true } } };
    }
    return { entry, bin: config.bin };
  }

  /** Never rejects: anything that throws is a 502, so a joined request and the
   *  pending map's cleanup never meet a rejected promise. */
  async function runStatus(entry: WikiRegistryEntry, bin: string, allowIdent: boolean): Promise<StatusAnswer> {
    try {
      return await spawnStatus(entry, bin, allowIdent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("felles-status failed: {error}", { error: message });
      return { http: 502, body: { error: `The status check failed: ${message}`, reason: "internal" } };
    }
  }

  async function spawnStatus(entry: WikiRegistryEntry, bin: string, allowIdent: boolean): Promise<StatusAnswer> {
    const argv = [...interpreter(), bin, ...fellesScriptArgs({ action: "status", dryRun: false, allowIdent, root: entry.root })];
    let proc;
    try {
      proc = await (deps.runProc ?? runProc)(argv, deps.statusTimeoutMs ?? FELLES_STATUS_TIMEOUT_MS, "felles-status", {
        env: fellesPublishChildEnv(),
        processGroup: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("felles-status did not run: {error}", { error: message });
      if (err instanceof ProcTimeoutError) {
        return { http: 504, body: { error: "The status script did not return in time.", reason: "timeout" } };
      }
      return { http: 502, body: { error: message, reason: "spawn" } };
    }
    if (proc.exitCode !== 0) {
      // The script prints its error on stderr, masked like everything it prints.
      const detail = proc.stderr.trim().split("\n").pop()?.slice(0, 300) || "no message";
      return { http: 502, body: { error: `The status script failed (exit ${proc.exitCode}): ${detail}`, reason: "script" } };
    }
    const parsed = parseFellesStatus(proc.stdout);
    if (!parsed.ok) {
      log.warn("felles-status answered an unexpected shape: {reason}", { reason: parsed.reason });
      return {
        http: 502,
        body: { error: `The status script answered something other than its status JSON (${parsed.reason}).`, reason: "bad-status" },
      };
    }
    return { http: 200, body: { ...parsed.status, checkedAt: now() } };
  }

  app.get("/api/wiki/felles-status", async (c) => {
    const refusal = decideFellesStatusRequest({
      secFetchSite: c.req.header("sec-fetch-site"),
      origin: c.req.header("origin"),
      host: c.req.header("host"),
      marker: c.req.header(FELLES_STATUS_HEADER),
    });
    if (refusal) return c.json({ error: refusal.error, reason: refusal.reason }, refusal.status);
    const wiki = (c.req.query("wiki") ?? "").trim();
    if (!wiki) return c.json({ error: "wiki is required" }, 400);
    const identParam = c.req.query("allowIdent") ?? "1";
    if (identParam !== "0" && identParam !== "1") return c.json({ error: "allowIdent must be 0 or 1" }, 400);
    const allowIdent = identParam === "1";
    const target = resolveTarget(wiki);
    if (target.refusal) return c.json(target.refusal.body, target.refusal.status);
    const { entry, bin } = target;
    if (!existsSync(bin)) return c.json({ error: `${FELLES_PUBLISH_BIN_ENV} names a file that does not exist` }, 501);

    const key = `${entry.name.toLowerCase()}\u0000${identParam}`;
    const cached = statusCache.get(key);
    const ttl = deps.statusTtlMs ?? FELLES_STATUS_TTL_MS;
    if (cached && cached.gen === generation && now() - cached.at < ttl) return c.json(cached.answer.body, cached.answer.http);

    let pending = statusPending.get(key);
    if (!pending || pending.gen !== generation) {
      const gen = generation;
      const promise: Promise<StatusAnswer> = runStatus(entry, bin, allowIdent).then((answer) => {
        if (answer.http === 200 && gen === generation) statusCache.set(key, { at: now(), gen, answer });
        if (statusPending.get(key)?.promise === promise) statusPending.delete(key);
        return answer;
      });
      pending = { gen, promise };
      statusPending.set(key, pending);
    }
    const answer = await pending.promise;
    return c.json(answer.body, answer.http);
  });

  app.post("/api/wiki/felles-publish", async (c) => {
    const refusal = decideStampRequest({
      contentType: c.req.header("content-type"),
      secFetchSite: c.req.header("sec-fetch-site"),
      origin: c.req.header("origin"),
      host: c.req.header("host"),
    });
    if (refusal) return c.json({ error: refusal.error, reason: refusal.reason }, refusal.status);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const wiki = typeof body?.wiki === "string" ? body.wiki.trim() : "";
    const relPath = typeof body?.relPath === "string" ? body.relPath.trim() : "";
    // Absent means publish; any other value, null included, is a 400.
    const action = body?.action === undefined ? "publish" : body.action;
    if (action !== "publish" && action !== "remove" && action !== "sync") {
      return c.json({ error: 'action must be "publish", "remove" or "sync"' }, 400);
    }
    if (action === "sync") {
      if (!wiki) return c.json({ error: "wiki is required" }, 400);
      if (body?.relPath !== undefined) return c.json({ error: "sync runs on the whole wiki and takes no relPath" }, 400);
    } else if (!wiki || !relPath) {
      return c.json({ error: "wiki and relPath are required" }, 400);
    }
    if (typeof body?.dryRun !== "boolean") return c.json({ error: "dryRun must be a boolean" }, 400);
    // The script refuses --tillat-ident with --fjern, so remove ignores it.
    if (action !== "remove" && typeof body?.allowIdent !== "boolean") {
      return c.json({ error: "allowIdent must be a boolean" }, 400);
    }
    const dryRun = body.dryRun;
    const allowIdent = body.allowIdent === true;
    // The retry after a failed data-file run: the page is already gone from the
    // bucket, so a page run would exit 3 and never reach the data files.
    if (body.dataFilesOnly !== undefined && (body.dataFilesOnly !== true || action !== "remove" || dryRun)) {
      return c.json({ error: "dataFilesOnly must be true, and only on a real remove" }, 400);
    }
    const dataFilesOnly = body.dataFilesOnly === true;

    const target = resolveTarget(wiki);
    if (target.refusal) return c.json(target.refusal.body, target.refusal.status);
    const { entry, bin } = target;
    let pageRel: string | undefined;
    let pageRelPaths: string[] = [];
    if (action !== "sync") {
      const index = await getWikiIndex({ root: entry.root });
      const meta = index?.resolveRelPath(relPath);
      if (!meta) return c.json({ error: `no page at "${relPath}"` }, 404);
      pageRel = meta.relPath;
      if (action === "remove") pageRelPaths = index!.pages.map((p) => p.relPath);
    }
    if (!existsSync(bin)) {
      return c.json({ error: `${FELLES_PUBLISH_BIN_ENV} names a file that does not exist` }, 501);
    }
    if (inFlight) {
      return c.json({ error: "A publish, remove or sync is already running. Wait for it to finish.", reason: "running" }, 409);
    }
    // Claimed before any await, so two requests cannot both pass the check.
    inFlight = true;
    try {
      // remove: the page's data files go with it, except one another local page
      // also reads or whose name the script refuses (`felles-remove.ts`). All
      // three lists ride the answer, so the dialog's confirm row names every
      // object the confirm deletes and every one it keeps.
      const removeFiles =
        action === "remove" && pageRel ? await fellesRemoveDataFiles(entry.root, pageRel, pageRelPaths) : undefined;
      const dataFiles = removeFiles?.dataFiles ?? [];
      const goneKey = `${entry.name.toLowerCase()}\u0000${(pageRel ?? "").normalize("NFC")}`;
      if (dataFilesOnly) {
        if (dataFiles.length === 0) return c.json({ error: "This page has no data files to remove." }, 400);
        // The retry deletes data files a published page may still show, so it
        // runs only on this process's own evidence that the page is gone.
        const seen = goneEvidence.get(goneKey);
        if (seen === undefined || now() - seen > (deps.goneTtlMs ?? FELLES_GONE_TTL_MS)) {
          goneEvidence.delete(goneKey);
          return c.json(
            {
              error:
                "This instance has no recent record that it deleted the page, so it will not delete its data files alone. Run Remove… again: it deletes the page if it is still in the bucket; if it is not, it shows the command that deletes its data files.",
              reason: "page-not-gone",
            },
            409,
          );
        }
      }
      // A real publish or sync can put any page back.
      if (!dryRun && action !== "remove") goneEvidence.clear();
      if (action === "sync") {
        // A sync can outlast the server's idleTimeout (255 s). Bun 1.3.10 measured
        // not cutting a pending handler at it; this keeps that true if it changes.
        (c.env as { timeout?: (req: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, 0);
      }
      const timeoutMs =
        action === "sync" ? (deps.syncTimeoutMs ?? FELLES_SYNC_TIMEOUT_MS) : (deps.timeoutMs ?? FELLES_PUBLISH_TIMEOUT_MS);
      const run = (relPathArg: string | undefined, alsoRemove?: readonly string[]) =>
        (deps.runProc ?? runProc)(
          [
            ...interpreter(),
            bin,
            ...fellesScriptArgs({ action: action as FellesAction, dryRun, allowIdent, root: entry.root, relPath: relPathArg, alsoRemove }),
          ],
          timeoutMs,
          "felles-publish",
          { env: fellesPublishChildEnv(), processGroup: true },
        );
      const [firstData, ...restData] = dataFiles;
      // A real remove deletes the page in a run of its own, then the data files
      // in a second, and only when the page run deleted the page
      // (`fellesFjernVerdict` `deleted`). After any other outcome the data files
      // stay: the page may still be published, or, on `missing`, a page
      // published under another name (this one before a rename) may still show
      // them. The dry run never asks the bucket, so it stays one run that names
      // every object.
      const realRemove = action === "remove" && !dryRun;
      const pageRunReal = realRemove && !dataFilesOnly;
      let proc;
      try {
        proc = dataFilesOnly
          ? await run(firstData, restData)
          : await run(pageRel, action === "remove" && dryRun ? dataFiles : undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = err instanceof ProcTimeoutError;
        // The page run's outcome is unknown, so it is no evidence the page is gone.
        if (pageRunReal) goneEvidence.delete(goneKey);
        if (dataFilesOnly) {
          // The page is still gone, so the retry is offered again.
          log.warn("felles-publish data-file retry did not finish: {error}", { error: message });
          if (timedOut) invalidateStatus();
          return c.json(
            {
              error: timedOut
                ? "The data-file delete did not return in time and was stopped. Some data files may already be gone; Retry data files runs it again."
                : `The data-file delete could not start: ${message}. Retry data files runs it again.`,
              reason: timedOut ? "timeout" : "spawn",
              dataFilesOnly: true,
              dataRun: "timeout",
              retryDataFiles: true,
              dataFiles,
            },
            timedOut ? 504 : 502,
          );
        }
        if (timedOut) {
          log.warn("felles-publish did not return: {error}", { error: message });
          // The whole process group is signalled, gcloud included, but a request
          // gcloud had already sent can have gone through before it stopped.
          if (!dryRun) invalidateStatus();
          const error =
            action === "remove"
              ? "The script did not return in time and was stopped. The page may or may not be deleted, and its data files were left alone. Run Remove… again: it deletes the page if it is still in the bucket; if it is not, it shows the command that deletes its data files."
              : action === "sync"
                ? "The sync did not return in time and was stopped. Pages uploaded before that are published — refresh the status before running it again."
                : "The publish script did not return in time and was stopped. An upload may already have finished — run a dry run to check.";
          return c.json({ error, reason: "timeout", ...(pageRunReal ? { pageRun: "timeout", retryDataFiles: false, dataFiles } : {}) }, 504);
        }
        // Bun.spawn threw: nothing ran, so the bucket is as the cache saw it.
        log.warn("felles-publish could not be spawned: {error}", { error: message });
        return c.json({ error: message }, 502);
      }
      const outputs = [proc.stdout.trimEnd(), proc.stderr.trimEnd()];
      let pageRun: FellesFjernVerdict | undefined;
      let dataRun: FellesFjernVerdict | undefined;
      let dataFilesExitCode: number | null | undefined;
      if (dataFilesOnly) {
        dataRun = fellesFjernVerdict(proc, dataFiles.length);
        dataFilesExitCode = proc.exitCode;
      } else if (pageRunReal) {
        pageRun = fellesFjernVerdict(proc, 1);
        const deleted = pageRun === "deleted";
        if (deleted) goneEvidence.set(goneKey, now());
        else goneEvidence.delete(goneKey);
        if (deleted && firstData !== undefined) {
          try {
            const dataProc = await run(firstData, restData);
            dataFilesExitCode = dataProc.exitCode;
            dataRun = fellesFjernVerdict(dataProc, dataFiles.length);
            outputs.push(dataProc.stdout.trimEnd(), dataProc.stderr.trimEnd());
          } catch (err) {
            dataFilesExitCode = null;
            dataRun = "timeout";
            const message = err instanceof Error ? err.message : String(err);
            log.warn("felles-publish data-file remove failed: {error}", { error: message });
            outputs.push(
              err instanceof ProcTimeoutError
                ? "The data-file delete did not return in time and was stopped. Some data files may already be gone."
                : `The data-file delete could not run: ${message}`,
            );
          }
        }
      }
      // Only a run that could have changed the bucket drops the status cache: a
      // dry run lists and scans, and must not make every Dry run cost a fresh
      // gcloud listing.
      if (!dryRun) invalidateStatus();
      // No relPath in the log line: a path the scanner flags is printed masked by
      // the script, and this line must not undo that.
      log.info("felles-publish {action} exit {exitCode} on {wiki} (dryRun {dryRun})", {
        action,
        exitCode: proc.exitCode,
        wiki: entry.name,
        dryRun,
      });
      const output = outputs.filter(Boolean).join("\n");
      if (removeFiles && pageRel) {
        // An exit other than 0 and 3 (a refused name, no gcloud) would fail the
        // same way again, so it gets the terminal command, not a retry.
        const retryDataFiles = dataRun === "failed" || dataRun === "timeout";
        return c.json({
          exitCode: proc.exitCode,
          dryRun,
          output,
          removes: [...(dataFilesOnly ? [] : [pageRel]), ...dataFiles].map((r) => r.normalize("NFC")),
          keptShared: removeFiles.shared,
          keptRefused: removeFiles.refused,
          dataFiles,
          ...(pageRun !== undefined ? { pageRun } : {}),
          ...(dataRun !== undefined ? { dataRun, dataFilesExitCode } : {}),
          ...(realRemove ? { retryDataFiles } : {}),
          ...(dataFilesOnly ? { dataFilesOnly: true } : {}),
        });
      }
      return c.json({ exitCode: proc.exitCode, dryRun, output });
    } finally {
      inFlight = false;
    }
  });
}
