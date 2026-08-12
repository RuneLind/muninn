/**
 * Share for `/summaries` — `POST /api/summaries/share` (SSE) + its preset list.
 *
 * The second consumer of the share layer, and deliberately a thin ADAPTER over
 * it: everything downstream of "which prose, which bot" is byte-shared with the
 * wiki surface (`routes/share-sse.ts` for the runner + the single-flight
 * registry, `src/share/*` for the presets, the body prep and the prompt).
 *
 * Four things differ from `POST /api/wiki/share`, and each is a decision:
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
 *  4. **The single-flight key is NAMESPACED** (`summaryShareFlightKey`) — one
 *     process-wide registry backs both surfaces, and a wiki whose registered
 *     name equalled a collection name would otherwise share slots with that
 *     collection's documents.
 *
 * Everything else the two routes have in common is now literally shared code:
 * the body validation is `parseShareRequestBody` (`src/share/wire.ts`) and the
 * two strings that name a surface — the `/agents` deep link and the bot-less
 * copy — are `ShareSseOptions` fields this route sets.
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
import { parseShareRequestBody, SHARE_LANGS } from "../../share/wire.ts";
// The dialog's surface copy — imported, never re-spelled: the 409 below and the
// dialog's own conflict line are the same sentence, and a reword that touched
// only one of them would split the route from the screen it answers.
import { SUMMARY_SHARE_COPY } from "../views/components/wiki-share-dialog.ts";
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
 * the id's basename with the extension dropped.
 *
 * **It is deliberately NOT the client's `docTitle`, which never consults huginn
 * and strips only `.md`.** The two agree on the common case (an `.md` id whose
 * document carries no title) and diverge otherwise, on purpose: this title
 * reaches the MODEL (the `SOURCE:` header) and names the `/agents` run card, and
 * for both of those huginn's own title is the better answer — it is what the
 * document says it is called, rather than what its filename happens to be. The
 * extension list is wider here for the same reason: a run card reading
 * `Share: Some Title.txt` is a filename leaking into a label.
 *
 * The residual is cosmetic and accepted: a document whose huginn title differs
 * from its filename shows one string in the panel header and the other on the
 * run card.
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

      // Every body-shape check is the SHARED `parseShareRequestBody`, error copy
      // included — the wiki route runs the same call with its own field list, so
      // the two surfaces cannot answer the same malformed body differently. The
      // ordering it encodes is this route's too: identity fields first (`source`
      // outranks `docId` outranks `preset`), then the language, then the caps.
      const parsed = parseShareRequestBody(body as Record<string, unknown>, {
        stringFields: ["source", "docId", "preset", "promptOverride", "extra"],
        required: ["source", "docId", "preset"],
      });
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      const sourceId = parsed.body.values.source ?? "";
      const docId = parsed.body.values.docId ?? "";
      const presetId = parsed.body.preset;
      const { lang, promptOverride, extra } = parsed.body;

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

      // **Per-document single-flight, claimed BEFORE the huginn fetch** — every
      // pre-commit 400 is behind us, so from here a second POST for this
      // document can only be a double-click, a reload mid-stream or a second
      // tab, and each of those buys a whole-document summarization.
      //
      // **This is the one place the two routes' orderings deliberately DIVERGE.**
      // The wiki route reads its page first because that read is local disk and
      // costs microseconds; here it is a network round-trip to huginn under a
      // 10s budget, so taken after the fetch two clicks a second apart both see
      // a free slot and both spend that round-trip before either 409s. It also
      // puts the code back in line with what `SHARE_SLOT_SLACK_MS` already says
      // it assumes — that the slot is taken first and the run's budget starts
      // inside it.
      //
      // `botConfig` still gates it: without a bot the scaffold only emits its
      // "no bots" app_error, and reserving the document for two minutes to say
      // so would be a wedge.
      let release: (() => void) | undefined;
      if (botConfig) {
        const acquired = acquireShareFlight(summaryShareFlightKey(source.collection, docId));
        if (!acquired.ok) {
          return c.json(
            {
              state: "running",
              expiresAtMs: acquired.expiresAtMs,
              // The machine-readable pair, plus a sentence for a caller that is
              // not the dialog (the dialog's own countdown copy ignores it).
              error: SUMMARY_SHARE_COPY.conflictLead,
            },
            409,
          );
        }
        release = acquired.release;
        // "requested", not "running": the slot is now claimed BEFORE the huginn
        // fetch, so at this point nothing has established that the document is
        // even readable. The line records an accepted request that holds the
        // document; the app_error paths below say what became of it.
        log.info(
          "Summary share requested: source={source} bot={bot} doc={doc} preset={preset} lang={lang}",
          {
            source: source.id,
            bot: botConfig.name,
            doc: docId,
            preset: presetId,
            lang,
          },
        );
      }

      // Everything from here on is resolution-dependent and therefore reported
      // on the committed stream (the scaffold owns the bot-less case itself).
      // The whole tail runs under a `catch` that RELEASES before rethrowing: the
      // slot is held now, and an unexpected throw in the prep would otherwise
      // reserve the document for the full expiry with nothing running.
      try {
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

        // No prompt ⇒ no model call, so the document is freed HERE rather than
        // riding the stream's `onSettled`. Same outcome either way (the scaffold
        // settles an app_error immediately), but an unreadable document should
        // not stay reserved for even one more await.
        if (!userPrompt) {
          release?.();
          release = undefined;
        }

        return streamShareSSE(c, {
          config,
          botConfig: botConfig ?? null,
          preflightError,
          systemPrompt,
          userPrompt,
          runName: `Share: ${title}`,
          // This surface's own two strings — without them the run card deep-links
          // to /wiki and the bot-less refusal talks about a wiki that isn't in
          // this story.
          sourcePage: "/summaries",
          noBotMessage: "No bots configured to write a share summary.",
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
