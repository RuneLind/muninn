/**
 * `GET /api/summaries/export?source=<id>&docId=<id>` — one captured summary as
 * a ZIP: `index.html` plus `frames/<sec>.jpg` for every slide the summary
 * quotes. Unzipped, the page opens from `file://` with its slides beside it.
 *
 * A download rather than a folder written server-side, because the frames live
 * on the machine that CAPTURED the talk (`~/.muninn/frames`, per host) and the
 * reader may be on the other one: a ZIP crosses that gap, a path does not.
 *
 * The document half is the share adapter's (`summaries-share.ts`): `source` →
 * collection through the registry FIELD, `doc.text` from huginn, the canonical
 * server-side strip (`prepareSummaryDocBody`). What this route adds is in
 * `src/summaries/export.ts` — the frame reference read off the markdown, the
 * relative rewrite, and the page. A quoted frame whose file is missing (deleted
 * on disk, captured on the other machine) is logged and the `<img>` keeps its
 * relative path: the reader sees the alt text, and the rest of the export is
 * unaffected — a slide is never a reason to refuse the page.
 *
 * Unknown source / empty or dot-segment docId ⇒ 400; huginn has no such
 * document ⇒ 404; huginn unreachable ⇒ 503, huginn erroring ⇒ 502 — all JSON,
 * all before any bytes of the archive.
 *
 * Three guards the frame half carries, each measured before it existed: only
 * the EXPORTING source's frame quotes count (`frameSourceByName(source.id)`),
 * the file is read only when its REAL path is under `<root>/<source>/` (the
 * `frames-routes.ts` rule — a symlink planted under the root served an outside
 * file into the archive), and a `..` doc id is refused before the fetch
 * (`isSafeDocId`).
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { readFile, realpath } from "node:fs/promises";
import { join, sep as pathSep } from "node:path";
import { fetchKnowledgeApi, KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import { encodeDocIdPath, getSummarySource, isSafeDocId } from "../../summaries/sources.ts";
import { prepareSummaryDocBody } from "../../share/body-prep.ts";
import { frameDirFor, frameSourceByName, framesRootDir } from "../../summaries/frames.ts";
import {
  EXPORT_FRAMES_DIR,
  EXPORT_PAGE_NAME,
  exportBaseName,
  findFrameReference,
  renderExportPage,
  rewriteFrameUrls,
} from "../../summaries/export.ts";
import { buildStoredZip, type ZipEntry } from "../../summaries/zip.ts";
import { summaryDocTitle } from "./summaries-share.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "summaries-export");

/** One summary document as huginn serves it (`GET /api/document/<c>/<id>`). */
export interface SummaryExportDoc {
  text?: string;
  title?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface SummariesExportDeps {
  /** Fetch one document. `null` ⇒ huginn has no such document. Throws
   *  `KnowledgeApiError` on any other failure. */
  fetchDoc: (collection: string, docId: string) => Promise<SummaryExportDoc | null>;
  /** Where kept frames are read from; default {@link framesRootDir}. A TEST MUST pass one. */
  framesRoot?: string;
}

const DOC_FETCH_TIMEOUT_MS = 10_000;

/**
 * NB `fetchKnowledgeApi` never returns `null` — a missing document is a thrown
 * `KnowledgeApiError` with `upstreamStatus` 404 — so the mapping below is what
 * makes this route's 404 real. The share adapter's twin has the same signature
 * but never returns `null` itself (its route reaches `null` through its own
 * `catch`), which is why the two fetchers are not one function.
 */
export function defaultSummariesExportDeps(knowledgeApiUrl: string): SummariesExportDeps {
  return {
    fetchDoc: async (collection, docId) => {
      try {
        return (await fetchKnowledgeApi(
          knowledgeApiUrl,
          `/api/document/${encodeURIComponent(collection)}/${encodeDocIdPath(docId)}`,
          { timeoutMs: DOC_FETCH_TIMEOUT_MS },
        )) as SummaryExportDoc;
      } catch (err) {
        if (err instanceof KnowledgeApiError && err.upstreamStatus === 404) return null;
        throw err;
      }
    },
  };
}

/**
 * RFC 6266 disposition: an ASCII fallback for the old parsers, `filename*` for
 * the rest, so a title with `æøå` downloads under its own name.
 */
export function contentDisposition(baseName: string): string {
  const ascii = baseName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${ascii}.zip"; filename*=UTF-8''${encodeURIComponent(baseName)}.zip`;
}

export function registerSummariesExportRoutes(
  app: Hono,
  config: Config,
  deps: SummariesExportDeps = defaultSummariesExportDeps(config.knowledgeApiUrl),
): void {
  const framesRoot = deps.framesRoot ?? framesRootDir();

  app.get("/api/summaries/export", async (c) => {
    c.header("Cache-Control", "no-store");
    const sourceId = c.req.query("source") ?? "";
    const docId = (c.req.query("docId") ?? "").trim();
    const source = getSummarySource(sourceId);
    if (!source) return c.json({ error: `unknown summary source "${sourceId}"` }, 400);
    if (!docId) return c.json({ error: "docId is required" }, 400);
    if (!isSafeDocId(docId)) return c.json({ error: "docId is not a document path" }, 400);

    let doc: SummaryExportDoc | null;
    try {
      doc = await deps.fetchDoc(source.collection, docId);
    } catch (err) {
      const status = err instanceof KnowledgeApiError ? err.statusCode : 502;
      log.warn("Export could not fetch {docId}: {error}", { docId, error: String(err) });
      return c.json({ error: err instanceof Error ? err.message : String(err) }, status === 503 ? 503 : 502);
    }
    if (!doc) return c.json({ error: "document not found" }, 404);

    let markdown = prepareSummaryDocBody(doc.text ?? "");
    const entries: ZipEntry[] = [];
    // A vertical with no frame source of its own (article, x-article, …) gets
    // no frames at all, whatever its markdown quotes.
    const frameSource = frameSourceByName(source.id);
    const ref = frameSource ? findFrameReference(markdown, frameSource) : null;
    if (ref) {
      const rewritten = rewriteFrameUrls(markdown, ref);
      markdown = rewritten.markdown;
      const dir = frameDirFor(ref.source, ref.id, framesRoot);
      // Containment on the REAL path, as `frames-routes.ts` does: the charset
      // gates make the spelling `<root>/<source>/<id>/<digits>.jpg`, but a
      // symlink at `<id>` points wherever it likes.
      const baseReal = await realpath(join(framesRoot, ref.source.name)).catch(() => null);
      for (const sec of rewritten.seconds) {
        try {
          const file = `${dir}/${sec}.jpg`;
          const fileReal = await realpath(file);
          if (baseReal === null || !fileReal.startsWith(baseReal + pathSep)) throw new Error("outside the frames root");
          const data = await readFile(fileReal);
          entries.push({ name: `${EXPORT_FRAMES_DIR}/${sec}.jpg`, data: new Uint8Array(data) });
        } catch {
          log.warn("Export of {docId} quotes frame {sec} of {source}/{id}, which is not on this machine", {
            docId,
            sec,
            source: ref.source.name,
            id: ref.id,
          });
        }
      }
    }

    const title = summaryDocTitle(docId, doc);
    const html = renderExportPage({
      title,
      url: doc.url,
      linkLabel: source.linkLabel,
      metadata: doc.metadata,
      markdown,
      sourceId: source.id,
    });
    entries.unshift({ name: EXPORT_PAGE_NAME, data: new TextEncoder().encode(html) });

    const zip = buildStoredZip(entries);
    log.info("Exported {docId}: {frames} frame(s), {bytes} bytes", {
      docId,
      frames: entries.length - 1,
      bytes: zip.length,
    });
    return new Response(zip.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(exportBaseName(title)),
        "Content-Length": String(zip.length),
        "Cache-Control": "no-store",
      },
    });
  });
}
