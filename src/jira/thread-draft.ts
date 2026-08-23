/**
 * The Jira draft as a TURN IN THE THREAD — everything about that path that is
 * worth deciding without a database, a model or an HTTP request.
 *
 * **Why the draft is a turn and not a product of one.** A Jira task is almost
 * never written from notes; it is discussed first, in the melosys web chat, which
 * retrieves over the same three collections through the `research_knowledge` MCP
 * tool. Condensing that discussion into notes and re-retrieving throws away both
 * halves of what the conversation did: the retrieval, and every adjustment the
 * person made to the answer. And the adjusting continues after the first draft —
 * which is exactly the loop the chat already runs, with full history. So the
 * draft is written as an ordinary turn: the user line is visible, the draft is a
 * normal assistant message, and both feed the next prompt.
 *
 * The consequence worth stating: this path has **no fenced citations block and no
 * fenced raw material**. The thread IS the context. What it does carry is the
 * template, the depth rider, the language rider and one rider of its own.
 *
 * Pure + IO-free, like `prompt.ts` and `templates.ts`.
 */

import { depthRider, languageRider, neutralizeJiraFence } from "./prompt.ts";
import { JIRA_STORED_MAX_SOURCES, toJiraCitation } from "./retrieval.ts";
import { extractJiraKeys } from "./verify-keys.ts";
import type { JiraCitation, JiraCoverage, JiraDepth } from "./wire.ts";

/**
 * One `research_citations` row, as the seeding needs it.
 *
 * Structurally a subset of `CitationRow` (`src/db/research-citations.ts`) so the
 * caller passes those straight in, but declared here so this module stays free of
 * the db layer — and with the same nullability, since every one of those columns
 * is nullable and a row written by an older/other producer really can carry a
 * null title.
 *
 * There is deliberately no `snippet`: `research_citations` never stored one. It
 * costs nothing on this path — the thread has no fenced source block to put
 * snippets in, the conversation itself is the context — and the toggle column
 * renders a row without one.
 */
export interface ThreadCitationRow {
  docId: string;
  collection: string;
  title?: string | null;
  url?: string | null;
  relevance?: number | null;
}

/**
 * Turn a thread's retrieved rows into the draft's stored hit set.
 *
 * Three rules, and each is answering a question the notes path answers a
 * different way:
 *
 *  1. **Dedup by `docId`.** A refinement discussion calls `research_knowledge`
 *     several times and the same issue comes back in most of them. The FIRST
 *     appearance is kept — the turn that actually introduced the document into the
 *     conversation — while the relevance is the MAX seen, since the later search
 *     that scored it higher was a better-aimed question about the same document.
 *     (The bare `docId` is the key here for the same measured reason
 *     `applyExclusions` uses it: the three collections' id spaces are disjoint.)
 *
 *  2. **`cited` is derived NOW, from the assistant's own replies.** The chat's
 *     tool handler writes every row `cited: false` — it cannot know, the reply
 *     does not exist yet — and unlike `/research` there are no `[n]` markers to
 *     read afterwards, because a chat turn names its sources in prose. So the
 *     signal is the Jira key (or the url) appearing in what the bot actually said.
 *     A source the conversation TALKED ABOUT is better grounding for the task than
 *     one that merely came back from a search.
 *
 *  3. **Cited first, then the rest by relevance, capped at the same 24** the
 *     notes path stores. Order is load-bearing downstream: depth slices from the
 *     top, so the sources the discussion used are the ones a shallow draft gets.
 */
export function seedThreadCitations(
  rows: ThreadCitationRow[],
  assistantTexts: string[],
): JiraCitation[] {
  const joined = assistantTexts.join("\n\n");
  const mentionedKeys = new Set(extractJiraKeys(joined));

  const byDoc = new Map<string, { row: ThreadCitationRow; relevance: number }>();
  for (const row of rows) {
    if (!row.docId || !row.collection) continue;
    const relevance = typeof row.relevance === "number" ? row.relevance : 0;
    const held = byDoc.get(row.docId);
    if (!held) {
      byDoc.set(row.docId, { row, relevance });
      continue;
    }
    if (relevance > held.relevance) held.relevance = relevance;
  }

  const scored = [...byDoc.values()].map(({ row, relevance }) => {
    // Built through the SHARED mapper, so the url unescape, the
    // doc-id-or-`/browse/` key resolution, the title humanization and the badge
    // overwrite are byte-identical to live retrieval. `n` is assigned after the
    // sort — it is a position, not an identity.
    const citation = toJiraCitation(
      {
        collection: row.collection,
        docId: row.docId,
        // A null title falls back to the doc id, which for `jira-issues` is
        // `<KEY>_<slug>.md` and humanizes into something readable anyway.
        title: row.title ?? row.docId,
        url: row.url ?? null,
        relevance,
      },
      0,
    );
    const cited = namedIn(citation, mentionedKeys, joined);
    return { citation, cited };
  });

  scored.sort((a, b) => {
    if (a.cited !== b.cited) return a.cited ? -1 : 1;
    return b.citation.relevance - a.citation.relevance;
  });

  return scored
    .slice(0, JIRA_STORED_MAX_SOURCES)
    .map((s, i) => ({ ...s.citation, n: i + 1 }));
}

/**
 * Did this text NAME this source — by Jira key, or by its url?
 *
 * The key half goes through {@link extractJiraKeys}, which is already
 * word-bounded. The URL half is the one that needed a rule: a bare `includes`
 * matched `…/browse/MELOSYS-81` inside `…/browse/MELOSYS-8150`, so the short
 * issue was called "used by the conversation" on the strength of a mention of a
 * completely different one — and `cited` drives the order, which drives the
 * depth slice and the reference list. A match therefore has to end the string or
 * be followed by something that cannot continue an identifier.
 */
function namedIn(citation: JiraCitation, mentionedKeys: Set<string>, text: string): boolean {
  if (citation.key && mentionedKeys.has(citation.key)) return true;
  return !!citation.url && mentionsUrl(text, citation.url);
}

/**
 * The url boundary rule. Exported only through {@link namedIn}'s two callers.
 *
 * The class is "characters that can CONTINUE AN ADDRESS", not "characters that
 * can continue an identifier": `/`, `?` and `#` each start a different page, so
 * `…/rammeavtale` counted as named by a mention of `…/rammeavtale/vedlegg` or
 * `…?v=2` — the same defect the identifier characters were added for, one
 * separator over. A match must therefore end the string or be followed by
 * something outside `[A-Za-z0-9_-/?#]`.
 */
function mentionsUrl(text: string, url: string): boolean {
  for (let from = 0; ; ) {
    const at = text.indexOf(url, from);
    if (at < 0) return false;
    const next = text[at + url.length];
    if (next === undefined || !/[A-Za-z0-9_\-/?#]/.test(next)) return true;
    from = at + 1;
  }
}

/**
 * Which of the sources the draft was allowed to use it ACTUALLY named.
 *
 * **Why the thread path needs this and the notes path does not.** There, the
 * prompt carries a fenced `KILDER:` block, so `citationsUsed` is a true statement
 * about what the model was shown and `## Referanser` lists exactly that. Here the
 * prompt has no citation block at all — the conversation is the context — so
 * appending the whole depth slice put links under the task for sources the turn
 * never mentioned, and the reference list stopped being a claim about the text.
 *
 * The signal is the same one `seedThreadCitations` uses for `cited`: the Jira key
 * (or the url) appearing in the prose, which is exactly how the turn instruction
 * asks the model to cite. Order is the slice's, so the list still reads
 * conversation-used first.
 */
export function citationsNamedInDraft(
  citations: JiraCitation[],
  markdown: string,
): JiraCitation[] {
  const mentionedKeys = new Set(extractJiraKeys(markdown));
  return citations.filter((c) => namedIn(c, mentionedKeys, markdown));
}

/**
 * The retrieval verdict for a thread-seeded hit set.
 *
 * Deliberately NOT `assessCoverage`: its inputs are per-sub-search diagnostics
 * (`lowConfidence`, `resultCount`) that exist only for a retrieval this path
 * never ran. What is knowable here is whether the conversation retrieved anything
 * at all — and `no_hits` is then a true statement, since a thread with no
 * citations really did produce nothing to ground the task in. `unreachable` has
 * no meaning here either: nothing was asked of huginn during this request.
 */
export function threadSeedCoverage(citations: JiraCitation[]): JiraCoverage {
  return citations.length > 0 ? "answer" : "no_hits";
}

/**
 * The per-turn system-prompt block for a draft turn.
 *
 * Template → depth rider → language rider → the reader's extra steer → this
 * path's own rider. The order is `prompt.ts`'s, for the reason stated there: a
 * per-bot template rewrites the SHAPE of the task, not the depth dial the reader
 * just set, so the riders go after it or the controls become decorative.
 *
 * **`SYNTHESIS_RULES_BODY` is not reused here either** — it drags in the
 * `<Callout>`/`<Verdict>` vocabulary the measured Jira paste subset forbids, and
 * on a `componentAnswers` bot that vocabulary is already in the system prompt,
 * which is exactly why this block ends by overriding it for this turn.
 */
export function buildThreadTurnInstruction(input: {
  instruction: string;
  depth: JiraDepth;
  extra?: string;
}): string {
  const parts = [
    "DENNE MELDINGEN ER EN BESTILLING PÅ EN JIRA-SAK. Skriv saken ut fra samtalen over — " +
      "problemet vi har diskutert, avklaringene som er gjort, og kildene du allerede har hentet " +
      "med `research_knowledge` i denne tråden. Ikke søk på nytt med mindre samtalen mangler noe " +
      "konkret du trenger.",
    neutralizeJiraFence(input.instruction.trim()),
    depthRider(input.depth),
    languageRider(),
  ];

  const extra = neutralizeJiraFence((input.extra ?? "").trim());
  if (extra) parts.push(`OGSÅ FRA INNSENDEREN (følg dette også):\n${extra}`);

  parts.push(
    // The citation contract, spelled for a path with no source block. The notes
    // path says the same thing beside its `KILDER:` fence; here the sources are
    // in the history, so the instruction has to name where they are.
    "KILDER: Når en påstand kommer fra noe du har hentet i denne samtalen, nevn kilden ved navn i " +
      "teksten — Jira-nøkkelen der den finnes («se MELOSYS-1234»), ellers sidetittelen. Bruk ALDRI " +
      "fotnotemarkører i klammer («[1]», «[2]») — de peker ikke på noe i den ferdige saken. Ikke skriv " +
      "en «## Referanser»-seksjon; den legges på automatisk.\n" +
      "Nevn aldri en Jira-nøkkel som ikke har vært oppe i samtalen. Ingen oppdiktede saksnumre.",
    // Last, and blunt: this turn's output is pasted into a Jira field. Everything
    // the bot normally does around an answer — a greeting, an offer to adjust it,
    // a `<Callout>` on a componentAnswers bot — becomes visible garbage there.
    "SVARFORMAT for denne meldingen: svar med selve saketeksten og ingenting annet. Ingen innledning, " +
      "ingen avslutning, ingen kommentar til oppgaven, ingen presentasjonskomponenter " +
      "(<Callout>, <Verdict>, <Pill> og lignende) — bare markdown i delmengden malen beskriver. " +
      "Ikke pakk svaret i en kodegjerde.",
  );

  return parts.join("\n\n");
}

/**
 * The one spelling of the `notes` placeholder / `retrieval_question` line.
 *
 * `notes` is NOT NULL, the page reads it as the «fra samtale» banner, and nothing
 * was condensed into a search on this path — so the same sentence answers both.
 * It lived as a template literal in the route AND in the runner, which is one
 * copy too many for a string the page string-matches on.
 */
export function threadSeedLine(threadName: string): string {
  return `fra samtale: ${threadName}`;
}

/**
 * The prefix both draft-turn user lines start with.
 *
 * It is load-bearing in ONE place: the history read that stands in for "the raw
 * material" when key verification decides amber-vs-red. A regenerate's own user
 * line NAMES the excluded sources («Ikke bruk disse kildene denne gangen:
 * MELOSYS-7264»), so leaving it in the raw material made every excluded key the
 * model re-used read amber — "the person wrote it" — when the truth is the
 * opposite: the person asked for it to be left out. The strip needs an exact
 * test, and this constant is it.
 *
 * Deliberately a VISIBLE prefix rather than an invisible marker (`<!-- … -->`,
 * the research flow's device): these lines are ordinary chat messages a person
 * scrolls past, and a marker only stays invisible where a renderer knows about
 * it. Recognising them therefore takes more than this prefix — see
 * {@link isJiraTurnLine}, which matches the whole single-line shape, because a
 * person's «Lag Jira-sak av dette:» above a pasted refinement thread starts with
 * this string too.
 */
export const JIRA_TURN_TEXT_PREFIX = "Lag Jira-sak";

/**
 * The exact shape of a composer turn line: the prefix, optionally `på nytt`, and
 * the `(<template>, <depth>)` parenthesis both builders below always emit.
 */
const JIRA_TURN_LINE_RE = /^Lag Jira-sak(?: på nytt)? \([^()\n]+, [^()\n]+\)\./;

/**
 * Is this message one of the composer's own turn lines?
 *
 * **Shape-matched and SINGLE-LINE**, not a prefix test on the whole message. A
 * bare `startsWith` dropped a person's «Lag Jira-sak av dette:» followed by the
 * pasted refinement notes — the entire paste left the raw material, so every key
 * in it flipped from amber ("you wrote it") to red ("fabricated") the moment the
 * reader saved. The composer's own lines are always one line of a fixed shape,
 * so requiring that shape costs nothing and refuses every free-form request.
 *
 * The residual runs in the SAFE direction — stripping less: a reader's `extra`
 * steer is appended to the regenerate line verbatim, so a MULTI-LINE steer makes
 * that line raw material again, which costs one amber row on an excluded key the
 * model re-used. Losing a person's paste costs every key in it.
 */
export function isJiraTurnLine(text: string): boolean {
  const line = text.trim();
  if (line.includes("\n")) return false;
  return JIRA_TURN_LINE_RE.test(line);
}

/** The visible user line for a first draft turn. It IS a normal user message —
 *  this is a conversation, and «lag en sak av dette» is a thing a person says. */
export function threadDraftTurnText(template: string, depth: JiraDepth): string {
  return `${JIRA_TURN_TEXT_PREFIX} (${template}, ${depth}).`;
}

/**
 * The visible user line for a regenerate.
 *
 * The exclusions ride as PROSE rather than as a machine list, because on this
 * path they are part of the conversation the next turn will read: "uten
 * MELOSYS-7264" is a sentence the model can act on, and one a person scrolling
 * the thread can understand. Doc ids with no Jira key are named by title, since
 * an opaque id tells a reader nothing.
 */
export function threadRegenTurnText(input: {
  template: string;
  depth: JiraDepth;
  /** The rows this run is excluding, resolved from the stored hit set. */
  excluded: JiraCitation[];
  extra?: string;
}): string {
  const parts = [`${JIRA_TURN_TEXT_PREFIX} på nytt (${input.template}, ${input.depth}).`];
  const labels = input.excluded.map((c) => c.key ?? c.title).filter(Boolean);
  if (labels.length > 0) {
    parts.push(`Ikke bruk disse kildene denne gangen: ${labels.join(", ")}.`);
  }
  const extra = (input.extra ?? "").trim();
  if (extra) parts.push(extra);
  return parts.join(" ");
}
