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
 * modes. The fixtures under `__fixtures__/` were captured through that very
 * function against the live corpus rather than hand-written, because the two
 * failure modes here are both invisible to a made-up sample.
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

/** ` **[UNDER ARBEID]**` sits between the title and the relevance in full mode. */
const WIP_SUFFIX = /\s*\*\*\[UNDER ARBEID\]\*\*\s*$/;

interface HeaderCandidate {
  title: string;
  relevance: number;
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
          // A URL from before this hit's header belongs to the previous hit.
          url: url !== null && (header === null || urlLine > header.line) ? url : null,
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

/** A header line, or `null` if the line is not one (the relevance suffix decides). */
function parseHeader(line: string): { title: string; relevance: number } | null {
  const brief = BRIEF_HEADER.exec(line);
  if (brief) {
    // Brief mode bolds the title, so the heading/wip/relevance tail is already
    // outside the capture — only the tail has to carry a relevance suffix.
    const rel = RELEVANCE_SUFFIX.exec(brief[2]!);
    if (!rel) return null;
    const title = brief[1]!.trim();
    return title ? { title, relevance: toRelevance(rel[1]!) } : null;
  }

  const full = FULL_HEADER.exec(line);
  if (full) {
    const rest = full[1]!;
    const rel = RELEVANCE_SUFFIX.exec(rest);
    if (!rel) return null;
    const title = rest.slice(0, rel.index).replace(WIP_SUFFIX, "").trim();
    return title ? { title, relevance: toRelevance(rel[1]!) } : null;
  }

  return null;
}

function toRelevance(percent: string): number {
  const n = Number(percent) / 100;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tools whose result is one of huginn's rendered document listings.
 *
 * Deliberately narrow. `research_knowledge` is muninn's OWN tool and persists
 * from its handler where it holds the decoded hits — claiming it here too would
 * write every row twice (its rendered text has no anchor line, so it would in
 * fact parse to nothing, but the name gate says so explicitly rather than relying
 * on that). `get_document` is included because the family is the adapter's, and
 * costs nothing: its render carries no anchor line either.
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
  return base === "search_knowledge" || base === "get_document";
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
