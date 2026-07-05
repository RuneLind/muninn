/**
 * Knowledge-domain mapping for summary/wiki categories.
 *
 * Splits the closed category taxonomy into two retrieval domains:
 *  - `ai`   — tech / AI / AI-career content (the ~90% majority)
 *  - `life` — health / parenting / entertainment
 *
 * The doc id encodes its category as a path prefix (`<category>/<title>.md`),
 * so the Summaries page derives each doc's domain client-side from
 * `docCategory(doc.id)`. The client JS can't import this module (it's a
 * server-rendered template literal), so the mapping table is injected as JSON
 * via `clientDomainMapJson()` — this file stays the single source of truth.
 *
 * Keyed by the top-level category segment (the part before the first `/`), so
 * every `ai/*` sub-category (ai/claude-code, ai/rag, …) resolves through the
 * `ai` entry. The live category set is closed + validated at ingest
 * (huginn `main/ingest/categories.py`); only legacy folder names can fall
 * off-list, and those default to `ai` (the base-rate majority).
 */

export type KnowledgeDomain = "ai" | "life";

/** Top-level category segment → domain. Mirrors huginn's closed CATEGORIES set. */
const DOMAIN_BY_CATEGORY: Record<string, KnowledgeDomain> = {
  ai: "ai",
  tech: "ai",
  coding: "ai",
  career: "ai",
  health: "life",
  parenting: "life",
  entertainment: "life",
};

/**
 * Map a category (e.g. `"ai/claude-code"`, `"health"`) to its domain.
 * Unknown / off-list categories default to `"ai"` (base rate).
 */
export function categoryToDomain(category: string): KnowledgeDomain {
  const top = category.split("/")[0] ?? "";
  return DOMAIN_BY_CATEGORY[top] ?? "ai";
}

/**
 * Serialize the top-level-segment → domain table for injection into the
 * Summaries page client script. The client mirrors `categoryToDomain` by
 * splitting on `/`, looking up the top segment, and defaulting to `"ai"`.
 */
export function clientDomainMapJson(): string {
  return JSON.stringify(DOMAIN_BY_CATEGORY);
}
