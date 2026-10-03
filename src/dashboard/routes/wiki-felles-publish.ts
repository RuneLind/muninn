/**
 * `POST /api/wiki/felles-publish` — run the operator's `publiser-felles-wiki.ts`
 * on one page of an allowlisted wiki, dry run or for real, and hand back what it
 * printed. See `src/wiki/felles-publish.ts` for why muninn shells out rather
 * than uploading itself.
 *
 * Body: `{ wiki, relPath, dryRun, allowIdent }`. Answers 200
 * `{ exitCode, dryRun, output }` whenever the script ran — its exit code is the
 * verdict (0 ok, 1 a file refused, 2 usage/environment, 3 an upload failed) and
 * its output is already masked by the script. Refusals before any spawn:
 * 415/403 (the stamp route's same-origin gate), 400 bad body, 501 not
 * configured, 403 a wiki not in `FELLES_WIKI_PUBLISH_WIKIS`, 404 no such page,
 * 409 while another publish runs (one at a time per process).
 * The page must be one the wiki index lists, and the script gets its index
 * spelling prefixed `./`: the script reads any argument starting with `-` as a
 * flag, and a `--` separator is unreliable (Bun swallows one placed directly
 * after the script path). The root is absolute, so it never starts with `-`.
 * A `WIKI_READONLY_ROOTS` root is refused (403): publishing ships the page off
 * the machine, the same egress every other read-only check refuses.
 */
import { existsSync } from "node:fs";
import type { Hono } from "hono";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { isReadonlyWikiRoot, wikiNoEgressReason } from "../../wiki/readonly.ts";
import {
  FELLES_PUBLISH_BIN_ENV,
  fellesPublishableFor,
  fellesPublishChildEnv,
  fellesPublishConfigFromEnv,
  fellesPublishFlags,
  type FellesPublishConfig,
} from "../../wiki/felles-publish.ts";
import { decideStampRequest } from "./wiki-stamp.ts";
import { ProcTimeoutError, runProc } from "../../utils/run-proc.ts";
import { getLog } from "../../logging.ts";

const log = getLog("wiki", "felles-publish");

/** gcloud lists the bucket and uploads per file; a cold gcloud start alone
 *  measures several seconds. */
export const FELLES_PUBLISH_TIMEOUT_MS = 120_000;

export interface FellesPublishRouteDeps {
  config?: () => FellesPublishConfig;
  runProc?: typeof runProc;
  timeoutMs?: number;
  /** The interpreter argv before the script. Default: the running Bun with
   *  `--no-env-file`, without which Bun loads muninn's own `.env` from the
   *  working directory and undoes the environment allowlist. */
  interpreter?: string[];
}

export function registerWikiFellesPublishRoute(app: Hono, deps: FellesPublishRouteDeps = {}): void {
  // One run at a time: every run targets the same bucket, and a dialog the
  // browser closed mid-run (Chrome makes a repeated Escape non-cancelable)
  // must not be able to start a second upload beside the first.
  let inFlight = false;
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
    if (!wiki || !relPath) return c.json({ error: "wiki and relPath are required" }, 400);
    if (typeof body?.dryRun !== "boolean" || typeof body?.allowIdent !== "boolean") {
      return c.json({ error: "dryRun and allowIdent must be booleans" }, 400);
    }
    const dryRun = body.dryRun;
    const allowIdent = body.allowIdent;

    const config = (deps.config ?? fellesPublishConfigFromEnv)();
    if (!config.bin) return c.json({ error: `${FELLES_PUBLISH_BIN_ENV} is not set on this instance` }, 501);

    const { entry, unknownWiki } = resolveWikiRequest(getWikiRegistry(), wiki, undefined, undefined);
    if (unknownWiki || !entry) return c.json({ error: "no wiki configured for that name" }, 404);
    if (!fellesPublishableFor(entry.name, config)) {
      return c.json({ error: "this wiki is not configured for felles publishing", reason: "not-a-publish-wiki" }, 403);
    }
    if (isReadonlyWikiRoot(entry.root)) {
      return c.json({ error: wikiNoEgressReason(entry.name), readonly: true }, 403);
    }
    const index = await getWikiIndex({ root: entry.root });
    const meta = index?.resolveRelPath(relPath);
    if (!meta) return c.json({ error: `no page at "${relPath}"` }, 404);
    if (!existsSync(config.bin)) {
      return c.json({ error: `${FELLES_PUBLISH_BIN_ENV} names a file that does not exist` }, 501);
    }

    const argv = [
      ...(deps.interpreter ?? [process.execPath, "--no-env-file"]),
      config.bin,
      ...fellesPublishFlags({ dryRun, allowIdent }),
      entry.root,
      "./" + meta.relPath,
    ];
    if (inFlight) {
      return c.json({ error: "A publish is already running. Wait for it to finish.", reason: "running" }, 409);
    }
    inFlight = true;
    let proc;
    try {
      proc = await (deps.runProc ?? runProc)(argv, deps.timeoutMs ?? FELLES_PUBLISH_TIMEOUT_MS, "felles-publish", {
        env: fellesPublishChildEnv(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ProcTimeoutError) {
        log.warn("felles-publish did not return: {error}", { error: message });
        // Only Bun is killed; a gcloud upload it started can still finish.
        return c.json(
          { error: "The publish script did not return in time. An upload may still have finished — run a dry run to check.", reason: "timeout" },
          504,
        );
      }
      log.warn("felles-publish could not be spawned: {error}", { error: message });
      return c.json({ error: message }, 502);
    } finally {
      inFlight = false;
    }
    // No relPath in the log line: a path the scanner flags is printed masked by
    // the script, and this line must not undo that.
    log.info("felles-publish exit {exitCode} on {wiki} (dryRun {dryRun})", {
      exitCode: proc.exitCode,
      wiki: entry.name,
      dryRun,
    });
    const output = [proc.stdout.trimEnd(), proc.stderr.trimEnd()].filter(Boolean).join("\n");
    return c.json({ exitCode: proc.exitCode, dryRun, output });
  });
}
