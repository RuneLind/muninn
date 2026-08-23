/**
 * Reading huginn's rendered search result back into structured hits.
 *
 * **Why a text parser and not the API.** The melosys bot reaches huginn two ways:
 * muninn's own `research_knowledge` MCP tool, which holds the decoded hits and
 * persists them itself (`thread-citations.ts`), and huginn's `knowledge` stdio
 * adapter, whose `search_knowledge` the model picks for ordinary single-topic
 * lookups — the commonest retrieval path by far. On that second path the only
 * thing muninn ever sees is the markdown the adapter rendered, so a thread whose
 * sources all came through it looked, to the Jira composer, like a conversation
 * that retrieved nothing at all.
 *
 * The grammar below is huginn's `mcp_adapter/formatting.render_results`, both
 * modes. The fixtures under `__fixtures__/` are hand-written to that grammar
 * with invented keys, titles and hosts — this repo is public and the corpus is
 * not — and each one carries the decoy of its mode explicitly, because that is
 * what a made-up sample otherwise leaves out.
 *
 * **The anchor is the `collection: … doc_id: …` line, and the header is chosen
 * by its relevance parenthetical.** Two structural traps, one per mode, and they
 * pull in opposite directions:
 *
 *  · In FULL mode a hit's chunk bodies follow its header, and those bodies are
 *    themselves markdown — a Jira issue's text contains `## Description`. Taking
 *    the FIRST `##` line since the previous hit therefore titles hit N+1 with a
 *    heading out of hit N's body.
 *  · In BRIEF mode a hit's snippet follows its header on the SAME entry, and the
 *    nav-wiki snippets embed their own `##` headings (`## Integrasjoner`). Taking
 *    the LAST `##` line before the anchor therefore titles the entry with its own
 *    snippet's heading.
 *
 * What both decoys lack is the ` (NN.N% relevant · band)` suffix the renderer
 * appends to a real header and to nothing else, so that — not position — is the
 * test. A header we cannot identify costs a title, never a row: `doc_id` and
 * `collection` are what the composer's hit set is keyed on, and they come off the
 * anchor line itself.
 *
 * **The parenthetical is not always there.** `_format_relevance_band` renders the
 * empty string for a result whose `relevance` is null, leaving the date tail
 * (`| updated: <date>` / `| <date>`) as the header's only evidence — so that is
 * accepted as the fallback, filing `relevance: null`. It costs more than a title
 * when it is missed: a rejected header leaves the row with no line to anchor its
 * url against, and the bare url out of the PREVIOUS hit's body then lands on it.
 *
 * Everything here is pure and total. Unknown lines are skipped, a block without a
 * `doc_id` is skipped, and nothing throws — this runs on the tool-result hot path
 * of every chat turn, where a parse failure must cost nothing but a missing row.
 */

/** One hit recovered from a rendered huginn search result. */
export interface HuginnHit {
  /** Huginn's document id — the composer's dedup key. */
  docId: string;
  collection: string;
  /** Header title verbatim, exactly as the `research_knowledge` path stores it. */
  title: string | null;
  url: string | null;
  /** 0–1, converted from the rendered percentage. */
  relevance: number | null;
}

/** The anchor. Full mode writes it flush left, brief mode indents it 3 spaces. */
const ANCHOR = /^\s*collection:\s*`([^`]+)`\s+doc_id:\s*`([^`]+)`\s*$/;

/** `## <title><wip><relevance><date>` — full mode. */
const FULL_HEADER = /^##\s+(\S.*)$/;

/** `<n>. **<title>**<heading><wip><relevance><date>` — brief mode. */
const BRIEF_HEADER = /^\s*\d+\.\s+\*\*(.+?)\*\*(.*)$/;

/** A line that is nothing but a URL — the renderer gives the url its own line. */
const URL_ONLY = /^\s*((?:https?|file):\/\/\S+)\s*$/;

/**
 * ` (100.0% relevant · high)`, optionally followed by the date suffix — full
 * mode writes `| updated: YYYY-MM-DD`, brief mode just `| YYYY-MM-DD`.
 *
 * Anchored to end-of-line because that is where the renderer puts it, and because
 * an unanchored match would happily accept a percentage quoted inside a snippet.
 */
const RELEVANCE_SUFFIX =
  /\s*\((\d+(?:\.\d+)?)%\s+relevant(?:\s*·[^)]*)?\)(?:\s*\|\s*(?:updated:\s*)?\d{4}-\d{2}-\d{2})?\s*$/;

/**
 * The date tail ALONE — the header huginn renders when a result's relevance is
 * null. `_format_relevance_band` returns `""` for that case, so the parenthetical
 * this module otherwise identifies a header by simply is not emitted, leaving
 * `## <title> | updated: <date>` (full) and `N. **<title>** > <s> | <date>`
 * (brief).
 *
 * Weaker evidence than the parenthetical, and deliberately the fallback rather
 * than a second first-class rule: a decoy `##` line inside a body would have to
 * end in ` | <ISO date>` to pass it. The cost of getting it wrong is bounded the
 * same way as before — a title and a relevance, never a row.
 */
const DATE_SUFFIX = /\s*\|\s*(?:updated:\s*)?\d{4}-\d{2}-\d{2}\s*$/;

/** ` **[UNDER ARBEID]**` sits between the title and the relevance in full mode. */
const WIP_SUFFIX = /\s*\*\*\[UNDER ARBEID\]\*\*\s*$/;

interface HeaderCandidate {
  title: string;
  /** `null` when the renderer emitted no relevance parenthetical at all. */
  relevance: number | null;
  /** Line index, so a URL line is only adopted if it follows its own header. */
  line: number;
}

/**
 * Parse a rendered huginn search result into hits. Returns `[]` for anything
 * that is not one — including a no-hit render, a `get_document` page (no anchor
 * line) and any other tool's output.
 */
export function parseHuginnHits(text: string): HuginnHit[] {
  // Cheap reject before splitting a possibly-large tool result into lines.
  if (!text || !text.includes("doc_id: `")) return [];

  const hits: HuginnHit[] = [];
  const seen = new Set<string>();

  // Reset at every anchor: a candidate belongs to the hit it precedes.
  let header: HeaderCandidate | null = null;
  let url: string | null = null;
  let urlLine = -1;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const anchor = ANCHOR.exec(line);
    if (anchor) {
      const collection = anchor[1]!;
      const docId = anchor[2]!;
      if (!seen.has(docId)) {
        seen.add(docId);
        hits.push({
          docId,
          collection,
          title: header?.title ?? null,
          // A URL from before this hit's header belongs to the previous hit —
          // and with no header of our own there is nothing to compare against,
          // so an unattributable url is dropped rather than guessed at. Getting
          // this wrong stamps the PREVIOUS hit's url on this row, which reads as
          // a real citation pointing at the wrong document.
          url: url !== null && header !== null && urlLine > header.line ? url : null,
          relevance: header?.relevance ?? null,
        });
      }
      header = null;
      url = null;
      urlLine = -1;
      continue;
    }

    const candidate = parseHeader(line);
    if (candidate) {
      // LAST wins: in full mode the real header is the last one before the
      // anchor, and in brief mode a snippet's embedded heading never carries a
      // relevance suffix, so it never becomes a candidate at all.
      header = { ...candidate, line: i };
      continue;
    }

    const bare = URL_ONLY.exec(line);
    if (bare) {
      url = bare[1]!;
      urlLine = i;
    }
  }

  return hits;
}

/**
 * A header line, or `null` if the line is not one.
 *
 * The relevance parenthetical decides; failing that, the date tail does, and the
 * hit is filed with `relevance: null` rather than a made-up zero — a hit huginn
 * scored 0.0 and a hit huginn did not score are different facts, and the
 * composer's hit list sorts on this column.
 */
function parseHeader(line: string): { title: string; relevance: number | null } | null {
  const brief = BRIEF_HEADER.exec(line);
  if (brief) {
    // Brief mode bolds the title, so the heading/wip/relevance tail is already
    // outside the capture — only the tail has to carry a suffix we recognize.
    const tail = matchHeaderTail(brief[2]!);
    if (!tail) return null;
    const title = brief[1]!.trim();
    return title ? { title, relevance: tail.relevance } : null;
  }

  const full = FULL_HEADER.exec(line);
  if (full) {
    const rest = full[1]!;
    const tail = matchHeaderTail(rest);
    if (!tail) return null;
    const title = rest.slice(0, tail.index).replace(WIP_SUFFIX, "").trim();
    return title ? { title, relevance: tail.relevance } : null;
  }

  return null;
}

/** The header's trailing evidence: the relevance parenthetical, else the date. */
function matchHeaderTail(
  rest: string,
): { index: number; relevance: number | null } | null {
  const rel = RELEVANCE_SUFFIX.exec(rest);
  if (rel) return { index: rel.index, relevance: toRelevance(rel[1]!) };
  const date = DATE_SUFFIX.exec(rest);
  if (date) return { index: date.index, relevance: null };
  return null;
}

function toRelevance(percent: string): number {
  const n = Number(percent) / 100;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tools whose result is one of huginn's rendered SEARCH results.
 *
 * Deliberately narrow — the search family and nothing else. `research_knowledge`
 * is muninn's OWN tool and persists from its handler where it holds the decoded
 * hits; claiming it here too would write every row twice (its rendered text has
 * no anchor line, so it would in fact parse to nothing, but the name gate says so
 * explicitly rather than relying on that).
 *
 * `get_document` USED to be admitted on the reasoning that `render_document`
 * carries no anchor line, so it cost nothing. It is not free: the anchor is a
 * grammar, and a page whose BODY quotes it — a wiki page documenting huginn's own
 * search output, which is exactly the kind of page a retrieval discussion pulls
 * up — parses to a hit for a document nobody retrieved. A tool that returns page
 * CONTENT can say anything; only the search family's output is huginn speaking.
 *
 * The four spellings are the four connectors: `mcp__knowledge__search_knowledge`
 * (claude-cli / claude-sdk), `knowledge-search_knowledge` (copilot-sdk), the bare
 * tool name (openai-compat, which names tools per `.mcp.json` without a prefix)
 * and the `search_knowledge (knowledge)` display form, accepted so a caller that
 * only has the formatted name still resolves.
 */
export function isHuginnSearchTool(name: string): boolean {
  if (!name) return false;
  const base = baseToolName(name);
  return base === "search_knowledge";
}

function baseToolName(name: string): string {
  // `search_knowledge (knowledge)` → `search_knowledge`.
  const display = /^(\S+)\s+\([^)]*\)$/.exec(name.trim());
  const raw = display ? display[1]! : name.trim();
  if (raw.includes("__")) {
    const parts = raw.split("__");
    return parts[parts.length - 1] ?? raw;
  }
  if (raw.includes("-")) {
    const parts = raw.split("-");
    return parts[parts.length - 1] ?? raw;
  }
  return raw;
}
