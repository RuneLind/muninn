/**
 * Share for `/summaries` — `POST /api/summaries/share` (SSE) + its preset list.
 *
 * The second consumer of the share layer, and deliberately a thin ADAPTER over
 * it: everything downstream of "which prose, which bot" is byte-shared with the
 * wiki surface (`routes/share-sse.ts` for the runner + the single-flight
 * registry, `src/share/*` for the presets, the body prep and the prompt).
 *
 * Three things differ from `POST /api/wiki/share`, and each is a decision:
 *
 *  1. **The client sends `{source, docId}`, never a collection.** Which huginn
 *     collection backs a source is a server-side registration detail
 *     (`SUMMARY_SOURCES`), and the mapping is read off the registry's
 *     `collection` FIELD — the two diverge (`x-article` → `x-articles`), so
 *     deriving one from the other silently queries a collection that does not
 *     exist. Mapping server-side also validates the source for free.
 *  2. **The bot is `resolveSummarizerBot`** — the bot currently holding the
 *     summarizer role, i.e. the one that wrote these documents. NOT
 *     `resolveWikiSynthesisBot`: there is no wiki here to own the answer, and
 *     the presets a reader picks from must come from the same bot that runs
 *     them or the picker offers instructions the generate call cannot honour.
 *  3. **The body is `doc.text` from huginn**, prepared by PR A's
 *     `prepareSummaryDocBody` — breadcrumb strip → frontmatter → the defensive
 *     head-anchored `tags:` leftover, in that order. The two client copies of
 *     that strip disagree with each other (`openSummaryDoc` does both,
 *     `openDocPanel` only the breadcrumb); the point of doing it here is that
 *     the shared post is not at the mercy of which viewer happened to open the
 *     document.
 *
 * The POST+SSE ordering contract is the wiki route's, verbatim and for the same
 * reason: every body check returns a plain JSON 400 BEFORE `streamShareSSE`
 * commits a 200, because after that a validation failure can only be an
 * `app_error` no client can tell from a model failure. An unknown `source` is
 * client-validatable, so it is a 400 too; a document huginn cannot serve is not,
 * so it is an `app_error` on the committed stream.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import type { executeOneShot } from "../../ai/one-shot.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { findSharePreset, resolveSharePresets, type SharePreset } from "../../share/presets.ts";
import { prepareSummaryDocBody } from "../../share/body-prep.ts";
import { buildShareSystemPrompt, buildShareUserPrompt } from "../../share/prompt.ts";
import {
  isShareLang,
  SHARE_EXTRA_MAX,
  SHARE_LANGS,
  SHARE_PROMPT_OVERRIDE_MAX,
} from "../../share/wire.ts";
import { acquireShareFlight, shareFlightKey, streamShareSSE } from "./share-sse.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "summaries-share");

/** One summary document as huginn serves it (`GET /api/document/<c>/<id>`). */
export interface SummaryShareDoc {
  text?: string;
  title?: string;
  url?: string;
}

/**
 * The two side-effecting seams, injected so the route tests can drive the whole
 * adapter — source mapping, strips, prompt assembly, single-flight, the terminal
 * `end` — without huginn and without a model call.
 */
export interface SummariesShareDeps {
  /** Fetch one document's body. `null` ⇒ huginn has no such document. */
  fetchDoc: (collection: string, docId: string) => Promise<SummaryShareDoc | null>;
  /** Test seam threaded into the runner; production leaves it unset. */
  oneShot?: typeof executeOneShot;
}

/** Doc fetch budget. Ten seconds, matching `/api/summaries/documents` — these
 *  are file reads on huginn's Python server, not a model call. */
const DOC_FETCH_TIMEOUT_MS = 10_000;

/** The real fetcher: huginn's document endpoint, path-segment-encoded exactly as
 *  the summaries client encodes it (a real doc id carries `/`, spaces and
 *  non-ASCII, and a bare interpolation truncates at `#`). */
export function defaultSummariesShareDeps(knowledgeApiUrl: string): SummariesShareDeps {
  return {
    fetchDoc: async (collection, docId) => {
      const encoded = docId.split("/").map(encodeURIComponent).join("/");
      return (await fetchKnowledgeApi(
        knowledgeApiUrl,
        `/api/document/${encodeURIComponent(collection)}/${encoded}`,
        { timeoutMs: DOC_FETCH_TIMEOUT_MS },
      )) as SummaryShareDoc | null;
    },
  };
}

/**
 * Display title for a summary doc — huginn's own `title` when it has one, else
 * the id's basename with the extension dropped, which is exactly what the
 * `/summaries` client's `docTitle` shows. It reaches the model (the SOURCE
 * header) and the `/agents` run card, so a mismatch with the row the reader
 * clicked is a real confusion, not cosmetics.
 */
export function summaryDocTitle(docId: string, doc: SummaryShareDoc | null): string {
  const fromDoc = doc?.title?.trim();
  if (fromDoc) return fromDoc;
  const base = docId.split("/").pop() ?? docId;
  return base.replace(/\.(md|mdx|txt)$/i, "") || docId;
}

/**
 * Single-flight key for a capture document.
 *
 * NAMESPACED, because `shareFlights` is one process-wide registry shared with
 * the wiki surface: without the prefix a wiki whose registered name happened to
 * equal a collection name would share slots with that collection's documents.
 * Unlikely, free to prevent, and impossible to debug from the 409 alone.
 */
export function summaryShareFlightKey(collection: string, docId: string): string {
  return shareFlightKey(`summaries:${collection}`, docId);
}

export function registerSummariesShareRoutes(
  app: Hono,
  config: Config,
  deps: SummariesShareDeps = defaultSummariesShareDeps(config.knowledgeApiUrl),
): void {
  // The preset list the dialog's picker renders. Read-only, model-free, and
  // resolved for the SUMMARIZER bot so the list matches the bot that will run
  // it. `no-store` for the same reason the wiki's is (see that route): a
  // heuristically cached list renders an id the POST then 400s, and a reload
  // replays the same cached list.
  app.get("/api/summaries/share/presets", (c) => {
    c.header("Cache-Control", "no-store");
    const botConfig = resolveSummarizerBot(discoverAllBots());
    return c.json({
      bot: botConfig?.name ?? null,
      presets: resolveSharePresets(botConfig?.prompts),
      langs: SHARE_LANGS,
    });
  });

  app.post("/api/summaries/share", async (c) => {
    // Wrapped like the wiki route: an unexpected throw returns 500 JSON rather
    // than an unhandled rejection, and the handover `catch` releases the slot
    // before rethrowing so a throw there cannot wedge the document.
    try {
      type Body = {
        source?: string;
        docId?: string;
        preset?: string;
        lang?: string;
        promptOverride?: string;
        extra?: string;
      };
      const body = await c.req.json<Body>().catch(() => ({}) as Body);

      // Body shape is client-controlled, so every field is type-checked before
      // any of them is used (the wiki route's precedent).
      for (const field of ["source", "docId", "preset", "promptOverride", "extra"] as const) {
        if (body[field] !== undefined && typeof body[field] !== "string") {
          return c.json({ error: `${field} must be a string` }, 400);
        }
      }

      const sourceId = typeof body.source === "string" ? body.source.trim() : "";
      if (!sourceId) return c.json({ error: "source is required" }, 400);
      const docId = typeof body.docId === "string" ? body.docId.trim() : "";
      if (!docId) return c.json({ error: "docId is required" }, 400);
      const presetId = typeof body.preset === "string" ? body.preset.trim() : "";
      if (!presetId) return c.json({ error: "preset is required" }, 400);
      if (!isShareLang(body.lang)) {
        return c.json(
          { error: `lang must be one of: ${SHARE_LANGS.map((l) => l.id).join(", ")}` },
          400,
        );
      }
      const lang = body.lang;
      const promptOverride = typeof body.promptOverride === "string" ? body.promptOverride : "";
      if (promptOverride.length > SHARE_PROMPT_OVERRIDE_MAX) {
        return c.json(
          { error: `promptOverride is longer than ${SHARE_PROMPT_OVERRIDE_MAX} characters` },
          400,
        );
      }
      // A PRESENT but blank override is a 400, never a silent fall back to the
      // preset — the model would follow an instruction the screen is no longer
      // showing, reported as that preset's output. (ABSENT is the unedited case.)
      if (body.promptOverride !== undefined && promptOverride.trim() === "") {
        return c.json({ error: "promptOverride is empty — omit it to use the preset" }, 400);
      }
      const extra = typeof body.extra === "string" ? body.extra : "";
      if (extra.length > SHARE_EXTRA_MAX) {
        return c.json({ error: `extra is longer than ${SHARE_EXTRA_MAX} characters` }, 400);
      }

      // Source → collection, through the registry FIELD. An unknown source is a
      // 400 rather than an app_error: the client picked it out of the same
      // registry the server holds, so it is client-validatable, and it must be
      // reported before the preset (a preset is only "unknown" relative to a
      // bot; the source is the thing that is actually wrong).
      const source = getSummarySource(sourceId);
      if (!source) return c.json({ error: `unknown summary source "${sourceId}"` }, 400);

      const botConfig = resolveSummarizerBot(discoverAllBots());
      // Validated against the shipped set even when no bot resolved: a bot's
      // `prompts/share*.md` files only override or EXTEND that set, so the
      // list is sound either way — and gating on the bot would let a bogus id
      // sail into a committed-200 app_error on a zero-bot install.
      const preset: SharePreset | undefined = findSharePreset(
        resolveSharePresets(botConfig?.prompts),
        presetId,
      );
      if (!preset) return c.json({ error: `unknown share preset "${presetId}"` }, 400);

      // Everything from here on is resolution-dependent and therefore reported
      // on the committed stream (the scaffold owns the bot-less case itself).
      let preflightError: string | null = null;
      let doc: SummaryShareDoc | null = null;
      try {
        doc = await deps.fetchDoc(source.collection, docId);
      } catch (err) {
        log.warn("Summary share: doc fetch failed collection={collection} id={id}: {error}", {
          collection: source.collection,
          id: docId,
          error: err instanceof Error ? err.message : String(err),
        });
        doc = null;
      }
      const title = summaryDocTitle(docId, doc);

      let systemPrompt = "";
      let userPrompt = "";
      if (!doc) {
        preflightError = `Could not read "${title}" from the ${source.label} archive.`;
      } else {
        // The canonical strip — the server owns it so the post never depends on
        // which client rendered the document.
        const prepared = prepareSummaryDocBody(doc.text ?? "");
        if (!prepared.trim()) {
          preflightError = `"${title}" has no text to summarize.`;
        } else {
          // No wiki name: this document came from a capture archive, and
          // claiming a wiki in the framing would be a fact the model repeats.
          systemPrompt = buildShareSystemPrompt("");
          userPrompt = buildShareUserPrompt({
            instruction: promptOverride.trim() || preset.content,
            lang,
            extra: extra.trim(),
            body: prepared,
            title,
          });
        }
      }

      // Per-document single-flight, taken ONLY when a model call will actually
      // run (`userPrompt` non-empty ⇒ fetch + prep succeeded; `botConfig` ⇒ the
      // scaffold gets past its "no bots" app_error). Same guard, same reason as
      // the wiki route: one POST buys a whole-document summarization, and a
      // double-click, a reload mid-stream or a second tab each buy another.
      let release: (() => void) | undefined;
      if (botConfig && userPrompt) {
        const acquired = acquireShareFlight(summaryShareFlightKey(source.collection, docId));
        if (!acquired.ok) {
          return c.json({ state: "running", expiresAtMs: acquired.expiresAtMs }, 409);
        }
        release = acquired.release;
        log.info("Summary share: source={source} bot={bot} doc={doc} preset={preset} lang={lang}", {
          source: source.id,
          bot: botConfig.name,
          doc: docId,
          preset: presetId,
          lang,
        });
      }

      try {
        return streamShareSSE(c, {
          config,
          botConfig: botConfig ?? null,
          preflightError,
          systemPrompt,
          userPrompt,
          runName: `Share: ${title}`,
          ...(deps.oneShot ? { oneShot: deps.oneShot } : {}),
          ...(release ? { onSettled: release } : {}),
        });
      } catch (err) {
        release?.();
        throw err;
      }
    } catch (err) {
      log.error("Summary share failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "share failed" }, 500);
    }
  });
}
