/**
 * Pure model for the wiki reader's "start a chat from here" popover.
 *
 * DOM-free and dependency-light on purpose (the `wiki-explain.ts` /
 * `wiki-integrate.ts` split rationale): `wiki-browser.ts` is bundled into the
 * browser, so everything decidable without a document — which user and which
 * connector a fresh escalation defaults to, how each option is labelled, and what
 * the thread will actually be named — lives here and is unit-tested, while the
 * bundle keeps only the wiring.
 *
 * `deriveAskThreadTitle` is imported from the SERVER's own `src/wiki/ask-chat.ts`
 * rather than re-implemented: that module is pure string work with no imports, and
 * the name preview must be byte-identical to the name the route creates (the
 * `synthesisTopicKey` precedent).
 */
import { deriveAskThreadTitle, deriveAskThreadTitleOrNull, type DeclineReason } from "../../../wiki/ask-chat.ts";
import { escHtml as esc } from "./escape.ts";
import { explainSelectionFromLabel } from "./wiki-explain.ts";

/**
 * The three things the popover can be opened for. They differ ONLY in where the
 * question comes from and what rides into the seed:
 * - `escalate` — a committed Ask/Explain turn (its answer + citations). Its question
 *   is READ-ONLY: the seed quotes that turn's answer and cites its sources, so an
 *   edited question would ship a verbatim answer to a question nobody asked.
 * - `direct`   — the "New chat" button beside the Ask box (which PREFILLS the
 *   dialog's own field once at open, and is never read again),
 * - `article`  — the "💬 Discuss" button on an open page (a question typed in the
 *   panel itself, about that page). Article mode has nothing to do with the Ask
 *   tab and neither reads nor writes its textarea.
 */
export type ChatOptMode = "direct" | "escalate" | "article";

/** One named connector row as `GET /api/wiki/chat-target` serves it — capability
 *  already resolved server-side (`connectorCapabilities` cannot run here). */
export interface ChatTargetConnector {
  id: string;
  name: string;
  connectorType: string;
  supportsWebTools: boolean;
}

/** The bot's own connector, i.e. what "(bot default)" actually means. */
export interface ChatTargetBotDefault {
  connectorType: string;
  model?: string;
  supportsWebTools: boolean;
}

/**
 * `GET /api/wiki/chat-target` response.
 *
 * `botName === null` ⇒ `reason` says why and `bots` carries the picker's options;
 * NOTHING else is present on that branch (the route used to ship four dummy
 * fields, and a `needsBot` boolean that only ever re-encoded `reason`). The
 * fields the ok branch fills are therefore optional here, and every consumer
 * below tolerates their absence.
 */
export interface ChatTarget {
  botName: string | null;
  reason?: "unknown_bot" | "bot_gone" | "needs_bot";
  error?: string;
  /** Only on the failure branch — the bot picker's options. */
  bots?: { name: string }[];
  users?: { id: string; name: string }[];
  defaultUserId?: string | null;
  /** Which user `preferredConnectorId` belongs to (a preference is per user+bot,
   *  so a client landing on a different user must refetch it). */
  preferredForUserId?: string | null;
  preferredConnectorId?: string | null;
  connectors?: ChatTargetConnector[];
  connectorsError?: string;
  botDefault?: ChatTargetBotDefault | null;
}

/** Where the chat page stores the user it is on — SHARED with this popover on
 *  purpose: the chat page overwrites it on every user switch and on the deep link
 *  this feature generates, so "the user I chat as" is one answer, not two. */
export function chatUserStorageKey(botName: string): string {
  return "muninn-chat-user-" + botName;
}

/** Last connector used for an escalation FROM this wiki. Scoped per wiki (not per
 *  bot): "which model reads mimir for me" is a per-wiki habit, and it deliberately
 *  does not disturb the chat page's own `muninn-connector-<bot>` sidebar memory. */
export function wikiConnectorStorageKey(wiki: string): string {
  return "muninn-wiki-chat-connector-" + (wiki || "__default__");
}

/**
 * Stored value meaning "(bot default) was a deliberate choice here".
 *
 * "(bot default)" is the empty connector id, and storing `""` was indistinguishable
 * from storing nothing: {@link pickConnectorId}'s membership test can never match
 * it, so the next open fell straight through to the user+bot chat preference and
 * silently re-selected a named model the reader had explicitly moved off. A
 * sentinel makes the choice rememberable; it is mapped back to `""` on read.
 */
export const WIKI_CONNECTOR_DEFAULT = "__default__";

/**
 * Which user the popover preselects: the remembered one (if this bot still has
 * it) → the bot's `bot_default_user` mapping → the sole user → none.
 *
 * Never positional beyond the sole-user case — picking `users[0]` out of several
 * attributes a thread (and everything the pipeline extracts from it) to whoever
 * happens to sort first.
 */
export function pickUserId(target: ChatTarget, stored?: string | null): string {
  const users = target.users ?? [];
  const has = (id?: string | null): boolean => !!id && users.some((u) => u.id === id);
  if (has(stored)) return stored as string;
  if (has(target.defaultUserId)) return target.defaultUserId as string;
  if (users.length === 1) return users[0]!.id;
  return "";
}

/**
 * Which connector the popover preselects: this wiki's last-used escalation
 * connector → the user+bot's persisted chat preference → `""` (bot default).
 *
 * A remembered id that no longer names a live connector row falls through rather
 * than preselecting an option the picker cannot show — but a remembered
 * {@link WIKI_CONNECTOR_DEFAULT} is a real remembered ANSWER and stops the chain.
 */
export function pickConnectorId(
  target: ChatTarget,
  stored?: string | null,
  preferred?: string | null,
): string {
  if (stored === WIKI_CONNECTOR_DEFAULT) return "";
  const rows = target.connectors ?? [];
  const has = (id?: string | null): boolean => !!id && rows.some((c) => c.id === id);
  if (has(stored)) return stored as string;
  if (has(preferred)) return preferred as string;
  return "";
}

/** What to store for a pick so it survives to the next open — the sentinel for
 *  "(bot default)", the id otherwise. */
export function connectorStorageValue(connectorId: string): string {
  return connectorId || WIKI_CONNECTOR_DEFAULT;
}

/** Suffix naming the one capability difference that changes what the seed may
 *  promise. Only ever states the ABSENCE — a "web search" badge on the majority
 *  of options is noise. */
function capabilitySuffix(supportsWebTools: boolean): string {
  return supportsWebTools ? "" : " · no web search";
}

/** Label for a named connector option. */
export function connectorOptionLabel(row: ChatTargetConnector): string {
  return row.name + capabilitySuffix(row.supportsWebTools);
}

/** Label for the empty "(bot default)" option — which is a REAL choice (it means
 *  "no connector on the thread", i.e. whatever the bot is configured with), so it
 *  carries its resolved capability like every other option. */
export function botDefaultOptionLabel(botDefault: ChatTargetBotDefault | null): string {
  if (!botDefault) return "Bot default";
  const model = botDefault.model ? " · " + botDefault.model : "";
  return (
    "Bot default (" + botDefault.connectorType + model + ")" +
    capabilitySuffix(botDefault.supportsWebTools)
  );
}

/** Whether the CHOSEN option can actually run a web search — the same resolution
 *  the route runs before deciding what the seed may claim. */
export function chosenSupportsWebTools(target: ChatTarget, connectorId: string): boolean {
  if (!connectorId) return !!target.botDefault?.supportsWebTools;
  const row = (target.connectors ?? []).find((c) => c.id === connectorId);
  return row ? row.supportsWebTools : !!target.botDefault?.supportsWebTools;
}

/**
 * The name the thread will really get: the typed override when it derives a name
 * at all, else the question — mirroring the route's own fallback exactly (a typed
 * name of only control characters has no name in it, so the question wins there
 * too), and through the same derivation, so the preview shows the same
 * lowercased, flattened, ≤50-char string `createThread` stores.
 */
export function previewThreadName(typed: string, question: string): string {
  return deriveAskThreadTitleOrNull(typed || "") ?? deriveAskThreadTitle(question || "");
}

/**
 * The thread name for the SUMMARY LINE — `""` when there is nothing to name it
 * after yet.
 *
 * {@link previewThreadName} answers `wiki ask` for a blank question, because
 * `createThread` needs SOME name and that is the stable generic fallback. Reporting
 * it in the summary of a dialog whose question box is still empty states a decision
 * nothing has made: the name-chip row (which refuses to offer the fallback as a
 * choice) is empty at exactly the same moment, so the two disagreed. Send is
 * blocked on an empty question anyway, so no name is ever actually derived from
 * one — and the moment the reader types, this fills in.
 */
export function summaryThreadName(typed: string, nameSource: string): string {
  if (!(typed || "").trim() && !(nameSource || "").trim()) return "";
  return previewThreadName(typed, nameSource);
}

/**
 * The question the popover would send RIGHT NOW — always its OWN field.
 *
 * Two sources now, and the collapse is deliberate:
 * - **Pinned** (the decline hook) — the question belongs to the TURN that failed
 *   and is fixed at open time. It is never read from the Ask box, and the box is
 *   never written to: overwriting it destroyed whatever draft the reader had
 *   typed, left the failed question armed in the box afterwards, and on the
 *   Connections tab wrote into a hidden textarea.
 * - **Everything else** — `state.question`, the dialog's own textarea, updated on
 *   input. Escalate seeds it from the turn, article starts it empty, direct
 *   PREFILLS it from the Ask box once at open ({@link openChatOptions}).
 *
 * Direct mode used to re-read the live Ask box at submit instead. That is what
 * made an empty box a dead end: the dialog said "Type a question first" while the
 * only field that could satisfy it sat UNDERNEATH the dialog, and on the
 * Connections tab it wasn't even rendered. Prefill-once keeps the reader's draft
 * (the box is left untouched) without making a covered control load-bearing.
 */
export function chatOptQuestion(
  state: { mode: ChatOptMode; question: string; pinnedQuestion?: string },
): string {
  if (typeof state.pinnedQuestion === "string") return state.pinnedQuestion.trim();
  return (state.question || "").trim();
}

// ── Article mode ("💬 Discuss" on an open page) ───────────────────────

/** The page fields the article popover renders from — a structural subset of the
 *  reader's `WikiListing`. `desc` rides ONLY the single-page `/api/wiki/page`
 *  response (see `toListing`'s `includeDesc`), so it is absent on an explainer
 *  opened straight from the list. */
export interface ChatOptArticle {
  name: string;
  title: string;
  relPath: string;
  /** Authored frontmatter `description` — rare (2/975 jarvis pages, 92/686 mimir). */
  description?: string;
  /** The page's first prose line, extracted at index time. */
  desc?: string;
  /** Frontmatter `updated`, verbatim, when the page declares one — only used to
   *  offer a "what changed since <date>" starter question, so a frontmatter-less
   *  wiki simply gets one chip fewer rather than a fabricated date. */
  updated?: string;
}

/** Id of the article popover's question field — shared by the render, the `input`
 *  delegation and any test, so the three can't drift. */
export const CHAT_OPT_QUESTION_ID = "wikiChatOptQ";

/** Id of the breadcrumb's article action — shared by the render, the click
 *  delegation and the click-away `inOpener` test (the `DECLINE_CHAT_BTN_ID`
 *  precedent: omitting it from `inOpener` makes the opening click read as a
 *  click-away and close the panel it just opened). */
export const DISCUSS_ARTICLE_BTN_ID = "wikiDiscussBtn";

/**
 * The breadcrumb's always-visible "💬 Discuss" action.
 *
 * It sits BESIDE the whole-article "🔎 Fact check" button rather than in the meta
 * row: both are article-level actions on the open page, and splitting them across
 * two rows makes neither findable. No user content is interpolated, so nothing
 * here needs escaping.
 */
export function discussArticleBtnHtml(): string {
  return (
    '<button class="wiki-bc-discuss" id="' + DISCUSS_ARTICLE_BTN_ID + '" ' +
    'title="Ask this wiki\'s bot about this article, in a real chat thread">' +
    "💬 Discuss</button>"
  );
}

/** Placeholder = the honest default. An empty question box on an article says
 *  "ask me something about this page"; a prefilled statement says "send this". */
export const ARTICLE_QUESTION_PLACEHOLDER = "What do you want to know about this article?";

/**
 * How much of the page summary the hint renders.
 *
 * `desc`/`description` are unbounded (mimir's longest is 1816 chars; 186 real
 * pages exceed 400), and the popover has no scroll of its own worth the name —
 * an unclamped hint pushed the Send button below the fold, i.e. the panel's only
 * action became unreachable by rendering a page's own summary.
 */
export const ARTICLE_HINT_MAX = 240;

/**
 * The dim line under the question box: what the page says about itself, as
 * context for what to ask — never as the question itself.
 *
 * **Neither summary prefills the box.** The authored frontmatter `description`
 * used to, and it is the same failure the `desc` demotion was written for: a
 * description is a declarative sentence (blog subtitles, sniffed `<meta>`
 * descriptions — 98 mimir pages carry one), Send is ENABLED on it, so one click
 * sent the page's own subtitle as the reader's question. The server then appended
 * the same string to the seed as the article parenthetical, so it arrived twice.
 * Both now land here, clamped, and the box stays empty behind
 * {@link ARTICLE_QUESTION_PLACEHOLDER}.
 */
export function articleChatHint(article: ChatOptArticle): string {
  const text = (article.description || article.desc || "").trim();
  if (text.length <= ARTICLE_HINT_MAX) return text;
  return text.slice(0, ARTICLE_HINT_MAX).trimEnd() + "…";
}

/**
 * The text a mode derives its DEFAULT thread name from.
 *
 * Article mode names the thread after the PAGE, not the question — the whole
 * design of this mode is that the article gets ONE discussion thread which every
 * later visit adds to (repeat visits therefore 409 by construction, and the
 * popover's "Send there →" is the primary, successful resolution). Naming it
 * after the first question would mint a sibling thread per visit instead.
 * A page with no usable title falls back to the question, so the name can never
 * collapse to the generic `wiki ask`.
 *
 * **The "no usable title" test is the ROUTE's**, not `.trim()`: the route asks
 * `deriveAskThreadTitleOrNull(page.title)`, which flattens control characters
 * away, so a title of `""` has no name in it there while `.trim()`
 * called it usable here — the preview then said `wiki ask` (the generic fallback
 * a truthy-but-nameless title lands on) while the server stored the
 * question-derived name.
 */
export function chatOptNameSource(
  mode: ChatOptMode,
  question: string,
  articleTitle?: string,
): string {
  if (mode !== "article") return question;
  return deriveAskThreadTitleOrNull(articleTitle || "") !== null ? (articleTitle as string) : question;
}

// ── Suggestions: what to ask, and what to call the thread ─────────────
//
// Both sets are TEMPLATES over data the reader's client already holds (the
// article's title/links/`updated`, the wiki name, the session's last question), so
// they cost no round-trip, no model call and no spend, and they are deterministic
// enough to unit-test. The empty question box beside a wall of pickers is the
// actual reason this dialog gets opened and abandoned; a model-generated set is a
// later, opt-in addition, not the v1 that has to work offline.

/** One suggestion chip. `label` is what the chip says; `question` is what it puts
 *  in the box — never what it sends (see {@link chatOptSuggestionsHtml}). */
export interface ChatOptSuggestion {
  label: string;
  question: string;
}

/** Longest chip label before it is clipped — chips wrap, and a full question as a
 *  label makes a five-chip row unreadable. */
export const SUGGESTION_LABEL_MAX = 34;

/**
 * Flatten and bound a string for a chip label or a prompt.
 *
 * Truncation walks CODE POINTS, not UTF-16 units: a title ending in an emoji or any
 * astral character would otherwise be cut through a surrogate pair, and half a pair
 * renders as U+FFFD — which is exactly why the server's own `truncateUnits` exists
 * (real thread names were observed carrying it).
 */
function clip(text: string, max: number): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let out = "";
  for (const ch of flat) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  // Prefer a word boundary, but never give back an empty string for a long first
  // word (a 200-char unbroken title would otherwise clip to just the ellipsis).
  const atWord = out.replace(/\s+\S*$/, "");
  return (atWord || out) + "…";
}

/**
 * A page title as it reads INSIDE a quoted sentence.
 *
 * Three treatments, all because the title is authored text that lands in a prompt:
 * bounded (a title is as long as its author felt like making it), markup-stripped
 * (an `.mdx` page titled `Turbo Fieldfare <b>x</b>` was sending the tags to the
 * model), and its double quotes turned into single ones — every template wraps the
 * title in `"…"`, so a title containing one produced unbalanced nesting the model
 * had to guess its way out of. This is a PROMPT-quality fix, not an escaping one:
 * every HTML sink here already runs `esc`.
 */
function titleForPrompt(title: string): string {
  const plain = (title || "").replace(/<[^>]*>/g, " ").replace(/["“”]/g, "'");
  return clip(plain, 90);
}

/**
 * The starter questions for this dialog, in chip order.
 *
 * Article mode asks about the page (and, when the rail gave us its outgoing
 * links, about how it connects); direct mode asks about the wiki as a whole. An
 * ESCALATE dialog gets none: its question came from a turn the reader already
 * asked, so a row of alternatives is an invitation to throw it away. A PINNED
 * question likewise has no chips — the call site renders no question box at all.
 */
export function suggestedQuestions(input: {
  mode: ChatOptMode;
  pinned?: boolean;
  article?: ChatOptArticle;
  /** Titles of pages this article links to (the rail's "Links to"), newest first.
   *  At most two are named, so the question stays a question. */
  links?: string[];
  /** Display name of the wiki being read — direct mode's chips are about it. */
  wiki?: string;
  /** The question that opened this reader's Ask session, if there was one. */
  lastQuestion?: string;
}): ChatOptSuggestion[] {
  if (input.pinned || input.mode === "escalate") return [];
  const out: ChatOptSuggestion[] = [];
  if (input.mode === "article") {
    const article = input.article;
    if (!article) return [];
    const t = titleForPrompt(article.title || "");
    if (!t) return [];
    out.push(
      { label: "Summarise it", question: `Summarise "${t}" and tell me what it is actually claiming.` },
      {
        label: "Strongest objection",
        question: `What is the strongest objection to the argument in "${t}", ` +
          "and does the page answer it?",
      },
      {
        label: "What would settle it",
        question: `What evidence would decide the central question in "${t}"?`,
      },
      { label: "Push back on it", question: `Which claims in "${t}" would you push back on, and why?` },
    );
    const links = (input.links || []).filter((l) => !!l && l !== article.title).slice(0, 2);
    if (links.length) {
      out.push({
        label: "How it connects",
        question: `How does "${t}" relate to ` +
          links.map((l) => `"${titleForPrompt(l)}"`).join(" and ") + "?",
      });
    }
    // Only offered when the page says when it was last touched: "what changed
    // since" with no since is not a question anyone can answer.
    if (article.updated) {
      out.push({
        label: "What changed since",
        question: `What has changed on this topic since "${t}" was last updated (${article.updated})?`,
      });
    }
    return out;
  }
  const wiki = clip(input.wiki || "", 40);
  const where = wiki ? `the "${wiki}" wiki` : "this wiki";
  out.push(
    { label: "What's new here", question: `What has been added to ${where} recently, and what is worth reading?` },
    {
      label: "Recurring themes",
      question: `Across ${where}, which themes keep coming up that I have not synthesised into a page yet?`,
    },
    { label: "Contradictions", question: `Where does ${where} contradict itself?` },
  );
  const last = (input.lastQuestion || "").trim();
  if (last) {
    out.push({
      label: "Continue “" + clip(last, 20) + "”",
      question: `Picking up an earlier question from this wiki session: ${clip(last, 400)}`,
    });
  }
  return out;
}

/** One thread-name chip: `value` goes into the name field verbatim (so an empty
 *  one is the "clear it" chip), `label` says where it came from. */
export interface ChatOptNameSuggestion {
  label: string;
  value: string;
}

/**
 * Names to offer for the thread.
 *
 * The DEFAULT is untouched — {@link chatOptNameSource} still derives it from the
 * page in article mode and the question everywhere else, which is what makes a
 * second Discuss on the same article land in the same thread (409 → "Send there
 * →") instead of minting a sibling per question. These chips are the opt-out:
 * "from question" is offered in article mode precisely so a reader who wants a
 * separate thread for a separate question can say so, and the dated chip is the
 * escape hatch from a collision the reader would rather not join.
 *
 * `today` is passed in, never read from the clock here: this runs inside a render,
 * and a function that reads `Date.now()` mid-render is untestable for the same
 * reason `sortPages` takes its `now`.
 */
export function threadNameSuggestions(input: {
  mode: ChatOptMode;
  question: string;
  articleTitle?: string;
  /** Short day label for the dated chip, e.g. `4 aug`. */
  today?: string;
}): ChatOptNameSuggestion[] {
  const out: ChatOptNameSuggestion[] = [];
  const fromPage = deriveAskThreadTitleOrNull(input.articleTitle || "");
  const fromQuestion = deriveAskThreadTitleOrNull(input.question || "");
  if (fromPage) out.push({ label: "from page", value: fromPage });
  if (fromQuestion && fromQuestion !== fromPage) {
    out.push({ label: "from question", value: fromQuestion });
  }
  const base = fromPage || fromQuestion;
  const day = (input.today || "").trim();
  if (base && day) {
    // Through the same derivation the field itself uses, so the chip can never
    // offer a name the route would truncate differently.
    out.push({ label: "dated", value: deriveAskThreadTitle(base + " " + day) });
  }
  return out;
}

/** Chip class — module-local on purpose. It is NOT the delegation's selector (both
 *  chip kinds share it, so a class-based handler would confuse a starter question
 *  with a thread name); the two data attributes below are. */
const CHAT_OPT_SUGGEST_CLASS = "wiki-chatopt-chip";
/** The starter-question chips' data attribute — shared by the render and the
 *  reader's click delegation, so the two can't drift. */
export const CHAT_OPT_SUGGEST_ATTR = "data-chat-q";
/** Same, for the thread-name chips. */
export const CHAT_OPT_NAME_CHIP_ATTR = "data-chat-name";

/**
 * The starter-question chip row.
 *
 * A chip FILLS the question box and leaves it editable — it never submits. That
 * is the same rule the `desc` prefill broke in #420: a one-click path from "a
 * sentence the page wrote about itself" to "a question sent as the reader's own"
 * is how the wiki ended up being asked its own subtitle. The full question rides
 * in `title=` so a clipped label is still readable before it is chosen.
 */
export function chatOptSuggestionsHtml(
  suggestions: ChatOptSuggestion[],
  heading: string,
): string {
  if (!suggestions.length) return "";
  return (
    '<div class="wiki-chatopt-slab">' + esc(heading) + "</div>" +
    '<div class="wiki-chatopt-chips">' +
    suggestions
      .map(
        (s) =>
          '<button type="button" class="' + CHAT_OPT_SUGGEST_CLASS + '" ' +
          CHAT_OPT_SUGGEST_ATTR + '="' + esc(s.question) + '" title="' + esc(s.question) + '">' +
          esc(clip(s.label, SUGGESTION_LABEL_MAX)) + "</button>",
      )
      .join("") +
    "</div>"
  );
}

/** The thread-name chip row, under the name field. `active` marks the chip whose
 *  value the field currently holds, so the row reports the state instead of just
 *  offering choices. */
export function chatOptNameChipsHtml(
  suggestions: ChatOptNameSuggestion[],
  active: string,
): string {
  if (!suggestions.length) return "";
  const typed = (active || "").trim();
  return (
    '<div class="wiki-chatopt-chips wiki-chatopt-namechips">' +
    suggestions
      .map(
        (s) =>
          '<button type="button" class="' + CHAT_OPT_SUGGEST_CLASS + " name" +
          (typed && typed === s.value ? " on" : "") + '" ' +
          CHAT_OPT_NAME_CHIP_ATTR + '="' + esc(s.value) + '" title="' + esc(s.value) + '">' +
          esc(s.label) + "</button>",
      )
      .join("") +
    // Always last, and always available: the field's own default (derived from the
    // page or the question) is what an empty value means, so "clear" is how the
    // reader gets back to it after trying a chip.
    '<button type="button" class="' + CHAT_OPT_SUGGEST_CLASS + " name" +
    (typed ? "" : " on") + '" ' + CHAT_OPT_NAME_CHIP_ATTR + '="" title="Use the default name">' +
    "default</button>" +
    "</div>"
  );
}

/**
 * Just the summary line's TEXT — the typing paths repaint this in place (a
 * wholesale re-render would take the caret with it), so it has to be one
 * implementation rather than two spellings that drift.
 *
 * A part is omitted when its value is unknown (a single-user install has no user
 * to name, a still-resolving target has no model), so the line never renders a
 * dangling separator or the word "thread" with nothing after it.
 */
export function chatOptSummaryTextHtml(input: {
  userName: string;
  modelLabel: string;
  threadName: string;
}): string {
  const parts: string[] = [];
  if (input.userName) parts.push("as <b>" + esc(input.userName) + "</b>");
  if (input.modelLabel) parts.push("<b>" + esc(input.modelLabel) + "</b>");
  if (input.threadName) parts.push("thread <b>" + esc(input.threadName) + "</b>");
  return parts.join(' <span class="sep">·</span> ');
}

/**
 * The one-line summary of every choice the collapsed options hold: who the chat
 * belongs to, which model answers, what the thread will be called.
 *
 * It replaces three always-open picker rows AND the separate "will be named
 * `…`" preview line — the panel opened at seven rows before the question, and the
 * three values it was asking about are already correct nearly every time.
 */
export function chatOptSummaryHtml(input: {
  userName: string;
  modelLabel: string;
  threadName: string;
  advOpen: boolean;
}): string {
  return (
    '<div class="wiki-chatopt-sum">' +
    '<span class="wiki-chatopt-sumtext">' + chatOptSummaryTextHtml(input) + "</span>" +
    '<button type="button" id="' + CHAT_OPT_ADV_ID + '" class="wiki-chatopt-advbtn" ' +
    'aria-expanded="' + (input.advOpen ? "true" : "false") + '">' +
    (input.advOpen ? "⚙ Hide options" : "⚙ Options") +
    "</button></div>"
  );
}

/** Id of the options disclosure toggle — shared by the render and the click
 *  delegation, the `CHAT_OPT_QUESTION_ID` precedent. */
export const CHAT_OPT_ADV_ID = "wikiChatOptAdv";

// ── Popover lifecycle: focus, Escape, navigation ──────────────────────

/**
 * A focused field's identity and caret, captured across an `innerHTML` swap.
 *
 * The panel is re-rendered wholesale from state — and in article mode the reader
 * is TYPING into it while the chat-target fetch is still in flight ("start typing
 * immediately" is the stated intent of rendering the question row above the
 * loading return). `loadChatTarget`'s `finally`, the user picker and the connector
 * picker all call `renderChatOptions()`, which replaces the node mid-word: focus
 * and caret are gone, and the next keystroke goes nowhere.
 */
export interface ChatOptFocus {
  id: string;
  /** Caret/selection, when the field has one (`<select>` has none). */
  start: number | null;
  end: number | null;
}

/**
 * The focus snapshot to restore after the swap, or `null` when nothing inside the
 * panel had focus.
 *
 * Duck-typed on purpose (an `{id, selectionStart, selectionEnd}` shape) so the
 * decision is unit-testable without a DOM; the caller supplies both the active
 * element and whether it is inside the panel.
 */
export function captureChatOptFocus(
  active: { id?: string; selectionStart?: number | null; selectionEnd?: number | null } | null,
  insidePanel: boolean,
): ChatOptFocus | null {
  if (!active || !insidePanel) return null;
  const id = typeof active.id === "string" ? active.id : "";
  if (!id) return null;
  return {
    id,
    start: typeof active.selectionStart === "number" ? active.selectionStart : null,
    end: typeof active.selectionEnd === "number" ? active.selectionEnd : null,
  };
}

/** Cap on the answer an escalation POSTs — mirrors the server's FACTCHECK_ANSWER_MAX
 *  (32k), the cap the two fact-check write routes enforce. The seed builder bounds
 *  the answer at 6k anyway, so a rehydrated 500 KB turn would only be uploading
 *  bytes the server is about to discard.
 *
 *  Lives HERE rather than in either caller because BOTH escalation paths apply it
 *  and they no longer share a file: the one-click bar is `wiki-browser.ts`'s
 *  `submitChatEscalate`, the dialog is `wiki-chat-options.ts`. Two copies of a cap
 *  that mirrors a server constant is exactly the pair that drifts. */
export const CHAT_ESC_ANSWER_MAX = 32_000;

/** Status copy for the first Escape on a typed question. */
export const CHAT_OPT_ESC_CONFIRM = "Press Esc again to discard this question.";

/**
 * What Escape does.
 *
 * A question the reader TYPED exists only inside this dialog, so a stray Escape
 * is the only copy of it gone: the first Escape arms a confirmation, the second
 * closes, and typing clears `escArmed` again so the confirmation can't go stale.
 *
 * The gate is `dirty`, not the mode. It used to be "article mode only", which was
 * right when article mode owned the only in-panel textarea; now every mode types
 * here. But a question the dialog PREFILLED (escalate's turn question, direct's
 * copy of the Ask box, a pinned decline question) is not the reader's unsaved
 * work — it is reproducible by re-opening, and prompting to discard it is noise.
 */
export function chatOptEscapeAction(state: {
  question: string;
  escArmed?: boolean;
  /** The reader has edited the question field in this dialog. */
  dirty?: boolean;
  /** The dialog reached a terminal state — the question was SENT (`doneUrl`) or is
   *  already queued on the target thread (`queuedUrl`). There is nothing left to
   *  discard, so offering to protect it read as a warning about work the reader had
   *  in fact just completed. */
  settled?: boolean;
}): "close" | "confirm" {
  if (state.settled) return "close";
  if (!state.dirty) return "close";
  if (!state.question.trim()) return "close";
  return state.escArmed ? "close" : "confirm";
}

/**
 * Whether an article-mode popover must close because the reader navigated the
 * article pane to a DIFFERENT page.
 *
 * Nothing else invalidates it: the panel keeps targeting page A (its `article` is
 * snapshotted at open) while the pane shows page B, its anchor button has been
 * detached by the re-render, and Send would quietly file the question against the
 * page the reader just left.
 */
export function shouldCloseArticleChatOnNavigate(
  state: { mode: ChatOptMode; article?: { relPath: string } } | null | undefined,
  relPath: string,
): boolean {
  if (!state || state.mode !== "article" || !state.article) return false;
  return (state.article.relPath || "") !== (relPath || "");
}

/**
 * The article context block — what page this is about, and what the page says
 * about itself.
 *
 * Its own bounded row ABOVE the question, not interleaved with the fields: the
 * anchored popover rendered "About …" and then "Page says: …" between the
 * textarea and the As/Model/Thread rows, which made the pickers read as belonging
 * to the excerpt and pushed Send toward the fold.
 */
export function articleChatContextHtml(article: ChatOptArticle): string {
  const hint = articleChatHint(article);
  return (
    '<div class="wiki-chatopt-ctx">About <b>' + esc(article.title) + "</b>" +
    (hint ? '<span class="wiki-chatopt-says">Page says: ' + esc(hint) + "</span>" : "") +
    "</div>"
  );
}

/** Placeholder for the modes that are NOT about one page. */
export const DIRECT_QUESTION_PLACEHOLDER = "What do you want to ask?";

/**
 * Whether the question is shown READ-ONLY rather than as an editable field.
 *
 * Two modes, one reason: the question is bound to a turn the dialog did not compose.
 * - **pinned** (the decline hook) — composed by `composeDeclineQuestion` out of the
 *   failed turn, so editing it detaches it from what it is escalating.
 * - **escalate** — the POST carries that turn's `answer` and `citations` verbatim
 *   (`submitChatOptions`), so an edited question ships a quoted answer to a
 *   question nobody asked, cited to sources that support the original. Before the
 *   dialog redesign this was structural: only article mode rendered a textarea, so
 *   an escalate question was frozen at open. Widening the field to every mode
 *   re-opened it, hence this explicit gate. A reader who wants to ask something
 *   else has "New chat", which seeds nothing.
 */
export function chatOptQuestionReadOnly(
  mode: ChatOptMode,
  pinned: boolean,
): boolean {
  return pinned || mode === "escalate";
}

/**
 * The question field — ONE textarea for all three modes (see
 * {@link chatOptQuestion}), rendered above the loading/error returns so the
 * reader can start typing while the chat target is still resolving.
 *
 * A PINNED question gets no textarea at all: it belongs to the declined turn, is
 * composed rather than verbatim, and editing it would silently detach it from the
 * turn whose failure it is escalating. {@link chatOptQuestionReadOnly} says which
 * modes that covers — escalate is one of them, for the same reason.
 */
export function chatOptQuestionHtml(mode: ChatOptMode, value: string): string {
  const placeholder = mode === "article"
    ? ARTICLE_QUESTION_PLACEHOLDER
    : DIRECT_QUESTION_PLACEHOLDER;
  return (
    '<textarea class="wiki-chatopt-q" id="' + CHAT_OPT_QUESTION_ID + '" rows="3" ' +
    'placeholder="' + esc(placeholder) + '">' + esc(value) + "</textarea>"
  );
}

/** The turn fields {@link composeDeclineQuestion} needs — a structural subset of
 *  the reader's `AskTurn` (and of the persisted `StoredAskTurn`, which carries
 *  both extra fields precisely so a rehydrated declined turn still composes). */
export interface DeclineQuestionTurn {
  /** The turn's displayed question — for an Explain turn this is the LABEL. */
  question: string;
  /** Explain turns: the page the passage was selected from (title, else name). */
  explainPage?: string;
  /** Follow-up turns: the question that opened this chain, already composed. */
  originQuestion?: string;
}

/**
 * The question a declined turn actually escalates with — which is NOT always its
 * displayed one.
 *
 * Two turn kinds carry a question that cannot be answered on its own, and both
 * reach the decline hook:
 * - an **Explain** turn's question is the display label `Explain: "<80-char
 *   slice>…"` (the real question is built server-side from `sel` and never comes
 *   back), so the passage is re-stated together with the page it was read on;
 * - a **follow-up** turn's question is the raw follow-up text ("and what about
 *   the second one?"), which only means anything after the question that opened
 *   the chain — so that origin is prepended.
 *
 * A plain Ask question is returned untouched. The two branches are exclusive by
 * construction (a follow-up always goes through the plain-question path, so it
 * never carries `explainPage`), and the origin is deliberately NOT re-wrapped
 * when it already equals the question.
 *
 * The framing stays third-person about the reader for the same reason
 * `buildDirectChatSeed`'s opening does: a first-person "I first asked …" is prose
 * the memory extractor happily records as a fact about the user.
 */
export function composeDeclineQuestion(turn: DeclineQuestionTurn): string {
  const question = (turn.question || "").trim();
  const page = (turn.explainPage || "").trim();
  if (page) {
    const sel = explainSelectionFromLabel(question);
    return sel
      ? `About the wiki page "${page}": explain this passage — "${sel}"`
      : `About the wiki page "${page}": ${question}`;
  }
  const origin = (turn.originQuestion || "").trim();
  if (origin && origin !== question) {
    return `Context — the earlier question in this wiki session was "${origin}". ` +
      `Follow-up: ${question}`;
  }
  return question;
}

/** What the popover's document-level click listener knows about one click. */
export interface ChatOptClickContext {
  /** The popover is open at all. */
  open: boolean;
  /** The click target is STILL in the document. A submit re-renders the panel
   *  from state, which detaches the very button that was clicked. */
  attached: boolean;
  /** The click landed inside the panel. */
  inPanel: boolean;
  /** The click landed on one of the two buttons that OPEN the panel. */
  inOpener: boolean;
  /** A submit is in flight (its own click is what re-rendered the panel). */
  sending: boolean;
}

/**
 * Whether a document click should dismiss the popover.
 *
 * The two non-obvious rules both come from the same failure: `submitChatOptions`
 * sets `sending` and re-renders SYNCHRONOUSLY before its first await, so by the
 * time this listener runs, the Send button the user clicked is detached — a bare
 * `closest("#wikiChatOpt")` test then reports "outside", the panel closes, and
 * the in-flight submit sees `chatOpt !== state` and closes the pre-opened tab.
 * Net effect: a thread and a seed were created server-side and the reader saw
 * nothing, with the retry hitting `alreadyQueued`. So a detached target is never
 * an outside click, and neither is anything at all while a submit is in flight.
 *
 * There used to be a third rule — a click in the Ask box didn't dismiss, because
 * direct mode read its question from there and "Type a question first" sent the
 * reader to a control OUTSIDE the panel to satisfy it. The dialog owns its
 * question now ({@link chatOptQuestion}), so the box is an ordinary outside click
 * again, and the exemption (plus the `mode`/`pinned` context it needed) is gone.
 */
export function shouldCloseChatOptions(ctx: ChatOptClickContext): boolean {
  if (!ctx.open) return false;
  if (ctx.sending) return false;
  if (!ctx.attached) return false;
  if (ctx.inPanel || ctx.inOpener) return false;
  return true;
}

/** Copy for the 409 a colliding thread name produces. Parameterized on WHERE the
 *  colliding name came from, because "a chat for this question already exists"
 *  is a lie when the reader typed the name themselves. */
export function conflictCopy(nameWasTyped: boolean): string {
  return nameWasTyped
    ? "A chat with that name already exists."
    : "A chat for this question already exists.";
}

/** Ids of the two 409 buttons — shared by {@link chatOptConflictFootHtml} and the
 *  reader's click delegation, so the markup and the handler can't drift. */
export const CHAT_OPT_SEND_THERE_ID = "wikiChatOptSendThere";
export const CHAT_OPT_FORCE_ID = "wikiChatOptForce";

/**
 * The whole 409 status line, per mode.
 *
 * In article mode a collision is the DESIGNED outcome, not a problem: the thread
 * is named after the page, so the second question about that page necessarily
 * collides with the first — and sending it to the existing thread is what makes
 * the article accumulate one discussion instead of a sibling thread per visit.
 * So the copy states that, rather than reporting a name clash the reader did
 * nothing to cause. A TYPED name is a different story in every mode: there the
 * reader chose the name, and "the question already has a chat" would be a lie.
 */
export function conflictStatusLine(
  nameWasTyped: boolean,
  mode: ChatOptMode,
  /** The colliding thread is NOT this article's (the route's `nameTaken` 409):
   *  its description carries no matching article tag, so it is an unrelated
   *  thread — quite possibly an ordinary `/topic` chat — that merely owns the
   *  name. Sending there would cross-seed someone else's conversation. */
  nameTaken = false,
): string {
  if (nameTaken) {
    return (
      (nameWasTyped
        ? "A different, unrelated chat already uses that name"
        : "The name this article's thread would use is taken by an unrelated chat") +
      " — start a new thread instead."
    );
  }
  if (mode === "article" && !nameWasTyped) {
    return "This article already has a chat thread — send your question there, " +
      "or start another.";
  }
  return conflictCopy(nameWasTyped) + " Send this question there, or start another.";
}

/** The status line's "you haven't typed anything yet" copy — shared by the model
 *  and the tests, since it is also the line that has to survive conflict copy. */
export const CHAT_OPT_EMPTY_QUESTION = "Type a question first.";

/** One rendered status line. */
export interface ChatOptStatusLine {
  text: string;
  error: boolean;
}

/**
 * Every line the status area shows, in order.
 *
 * A `status` (a conflict, an error, a confirmation) no longer SUPPRESSES the
 * blocked-Send guidance: after a 409 with an emptied question, the conflict copy
 * owned the line, both conflict buttons stayed live, and clicking one fired a
 * blank tab that opened and closed with no feedback at all. The guidance now
 * renders under whatever status is there — and {@link chatOptConflictFootHtml}
 * disables the buttons to match.
 */
export function chatOptStatusLines(input: {
  status?: string;
  statusIsError?: boolean;
  /** A chat target resolved — before that, guidance about it is premature. */
  hasTarget: boolean;
  question: string;
  hasUser: boolean;
}): ChatOptStatusLine[] {
  const lines: ChatOptStatusLine[] = [];
  if (input.status) lines.push({ text: input.status, error: !!input.statusIsError });
  if (!input.hasTarget) return lines;
  if (!input.question.trim()) lines.push({ text: CHAT_OPT_EMPTY_QUESTION, error: false });
  else if (!input.hasUser) lines.push({ text: "Pick who this chat belongs to.", error: false });
  return lines;
}

/**
 * The 409 action row.
 *
 * "Send there →" is the PRIMARY action in every mode (filled button, first in the
 * row) and "Start new thread" the ghost second choice — the reverse would make
 * every repeat visit to an article mint a new thread, which is exactly the
 * failure article mode is shaped to avoid. The wording is deliberately identical
 * across modes; what changes is the LINE above it ({@link conflictStatusLine}),
 * which is where "this is the normal, successful outcome" gets said.
 *
 * Two states change the row itself:
 * - **`nameTaken`** — the colliding thread is not this article's, so there is no
 *   "there" to send to. "Start new thread" is the only action, and it becomes the
 *   primary (no `ghost`): offering "Send there →" would cross-seed an unrelated
 *   conversation.
 * - **`disabled`** — the question is empty, and both actions POST it. Live
 *   buttons fired a blank tab that opened and closed with zero feedback.
 */
export function chatOptConflictFootHtml(
  opts: { nameTaken?: boolean; disabled?: boolean } = {},
): string {
  const dis = opts.disabled ? " disabled" : "";
  const force =
    '<button id="' + CHAT_OPT_FORCE_ID + '" class="wiki-chatopt-btn' +
    (opts.nameTaken ? "" : " ghost") + '"' + dis + ">Start new thread</button>";
  if (opts.nameTaken) return force;
  return (
    '<button id="' + CHAT_OPT_SEND_THERE_ID + '" class="wiki-chatopt-btn"' + dis + ">" +
    "Send there →" +
    "</button>" +
    force
  );
}

/** Id of the decline hook's button — shared by {@link declineChatBarHtml}, the
 *  reader's click delegation and its click-away opener test, so the three can't
 *  drift. */
export const DECLINE_CHAT_BTN_ID = "wikiChatDeclineBtn";

/** Why the wiki declined, in the reader's words. `low_confidence` must NOT read as
 *  "nothing found" — weak sources did ride out and are listed under the answer, so
 *  the honest framing is "nothing solid", not "nothing". And `unreachable` must not
 *  read as either: the search never happened, so the wiki's contents are unknown,
 *  not empty. */
function declineNote(reason: DeclineReason): string {
  if (reason === "low_confidence") return "The wiki had nothing solid on this.";
  if (reason === "unreachable") return "The wiki search could not be reached.";
  return "The wiki had nothing on this.";
}

/**
 * The decline hook: the whole inner markup of the escalate bar for a turn the wiki
 * DECLINED to answer, rendered in place of the ordinary "Continue in chat →"
 * button. Pure `reason → html` (no user content is interpolated, so nothing here
 * needs escaping) and it is what makes the hook derivable from turn state alone —
 * `wiki-browser.ts` holds only the wiring.
 *
 * The action is the direct-mode chat path: an honest failure is exactly the moment
 * to offer the bot its tools and memories instead of the wiki index, and the reader
 * should not have to retype the question to get there. (The complementary case —
 * a confident answer the reader still wants to take further — is served by the
 * always-visible "New chat" button beside the Ask box.)
 */
export function declineChatBarHtml(reason: DeclineReason): string {
  return (
    '<span class="wiki-chatesc-msg">' + declineNote(reason) + "</span>" +
    '<button id="' + DECLINE_CHAT_BTN_ID + '" class="wiki-chatesc-btn wiki-chatesc-decline">' +
    "Ask in chat instead →</button>"
  );
}

/** Escalation state of one Ask turn, held on the TURN and never in the DOM:
 *  `#wikiChatEscBar` is a singleton node owned by whichever turn is painted, so a
 *  fetch resolving after a turn switch used to paint turn A's "✓ Opened in chat"
 *  (linking A's thread) onto turn B's bar — and on the error path wrote into a
 *  detached node, so the user saw no error at all. */
export interface ChatEscState {
  status: "pending" | "done" | "exists" | "error";
  /** `done`: the thread just created · `exists`: the thread that already covers
   *  this question (built from the 409 body). Absent when the server didn't say. */
  chatUrl?: string;
  /** Whether the deep link actually got a tab — a blocked popup says so honestly
   *  instead of claiming it opened one. */
  opened?: boolean;
  /** Failure copy for the `error` state. */
  message?: string;
}

/** The turn fields {@link chatEscBarHtml} renders from — a structural subset of
 *  the reader's `AskTurn`. */
export interface ChatEscTurn {
  answer: string;
  kind?: string;
  declined?: DeclineReason;
  chatEsc?: ChatEscState;
}

/**
 * Inner markup of the escalate bar, DERIVED from turn state so a re-render — a
 * `done` refresh, a turn switch, re-opening the turn from history — reproduces
 * the state instead of losing (or misattributing) it.
 *
 * **Branch order is load-bearing.** A REALISED escalation (`done`/`exists` — a
 * thread exists and the reader's only way back to it is this link) outranks the
 * decline hook, which is an offer to start one. Ordering the decline check first
 * shadowed the link silently: a declined turn whose escalation succeeded went on
 * showing "Ask in chat instead →", and the second click walked 409 recovery for a
 * thread the reader could no longer reach.
 */
export function chatEscBarHtml(turn: ChatEscTurn): string {
  // No committed answer (still streaming, or a turn that died at app_error / an
  // SSE drop): the click's only possible outcome is a silent no-op, so render no
  // bar at all rather than a button that does nothing.
  if (!turn.answer) return "";
  // Fact-check turns are excluded: the question is synthetic and the answer is
  // tool-produced, so the seed's "answered from indexed page excerpts alone — no
  // memories, no tools" framing would be false.
  if (turn.kind === "factcheck") return "";
  const st = turn.chatEsc;
  if (st?.status === "done") {
    return (
      '<a class="wiki-chatesc-done" href="' + esc(st.chatUrl || "") + '" target="_blank">' +
      (st.opened ? "✓ Opened in chat →" : "Chat thread created — open it →") +
      "</a>"
    );
  }
  if (st?.status === "exists") {
    // A 409 is NOT auto-retried with `forceNew` — that minted a fresh thread (and
    // a fresh auto-sent model turn) on every re-click. Offer the existing thread,
    // and make starting another an explicit second choice.
    return (
      '<span class="wiki-chatesc-msg">A chat for this question already exists' +
      (st.chatUrl
        ? ' — <a class="wiki-chatesc-done" href="' + esc(st.chatUrl) + '" target="_blank">Open it →</a>'
        : "") +
      "</span>" +
      '<button id="wikiChatEscNewBtn" class="wiki-chatesc-btn">Start new thread</button>'
    );
  }
  // The wiki declined this question (no hits, or only weak nearest-neighbours):
  // offer the chat escalation as the PROMINENT next step instead of the ordinary
  // "Continue in chat →" button, which reads as an optional extra on an answer
  // that doesn't exist. Derived from `turn.declined`, so it survives a turn
  // switch and a reload.
  if (turn.declined) return declineChatBarHtml(turn.declined);
  const pending = st?.status === "pending";
  return (
    '<button id="wikiChatEscBtn" class="wiki-chatesc-btn"' + (pending ? " disabled" : "") + ">" +
    (pending ? "Opening chat…" : "Continue in chat →") + "</button>" +
    // Same escalation, with the choices the one-click path decides for you (user,
    // model, thread name). Opens the shared popover.
    '<button id="wikiChatEscOptBtn" class="wiki-chatesc-gear" title="Chat options…"' +
    (pending ? " disabled" : "") + ' aria-label="Chat options">⚙</button>' +
    '<span class="wiki-chatesc-msg' + (st?.status === "error" ? " error" : "") +
    '" id="wikiChatEscMsg">' + esc(st?.status === "error" ? st.message || "" : "") + "</span>"
  );
}
