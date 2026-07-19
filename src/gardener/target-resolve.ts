/**
 * Target-resolve stage — decide whether a cluster becomes a NEW page or an
 * UPDATE to an existing one, using the LOCAL wiki store as the oracle (fresh +
 * exact, immune to huginn index staleness). Huginn search scores are never
 * consulted for the mode decision (rank-based, not confidence).
 */

import path from "node:path";
import type { Cluster, ResolvedTarget } from "./types.ts";
import type { WikiProposalKind } from "../db/wiki-proposals.ts";
import type { WikiIndex } from "../wiki/store.ts";

/** Normalize a title/alias/label for near-match comparison. */
export function normalizeLabel(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The wiki dir a page belongs in, given its domain + kind. Mirrors the wiki's
 * folder layout: `concepts/`, `entities/`, `sources/` (each under `life/` for the
 * life domain). Typed `WikiProposalKind` (not `ClusterKind`) so the source-page
 * drafter — which produces `source` proposals the weekly clusterer never emits —
 * shares this one mapping; `resolveTarget` below only ever passes concept/entity.
 */
export function expectedDir(domain: "ai" | "life", kind: WikiProposalKind): string {
  const sub = kind === "concept" ? "concepts" : kind === "source" ? "sources" : "entities";
  return domain === "life" ? `life/${sub}` : sub;
}

/** Strip filesystem-unsafe bits from a label so it can be a filename stem. */
export function sanitizeFilename(label: string): string {
  return label
    .replace(/[\\/]+/g, " ")
    .replace(/[<>:"|?*]/g, "")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve a cluster to a create/update target. `update` when the label is a
 * normalized near-match of an existing page's title or alias; otherwise `create`
 * (the default for anything ambiguous — a duplicate page is recoverable at the
 * human gate, a wrong-page update wastes the cluster).
 *
 * Match candidates are pages of the SAME domain whose type is concept or
 * entity. Same-kind matches win outright; a cross-kind match (an "entity"
 * cluster titled like an existing concept page) is still an update — the
 * wiki's existing classification beats the cluster model's guess, and the
 * returned `kind` re-kinds the cluster so the draft folds into the canonical
 * page instead of creating a same-title sibling in the other folder.
 * Other page types (source/analysis/note/explainer) and cross-domain pages
 * are NEVER match targets: a title collision with them must not turn into an
 * update that overwrites them — nothing downstream re-checks the existing
 * page's type (shapeGate judges the draft's own frontmatter, and
 * isPathConfined's update branch is pure path equality).
 */
export function resolveTarget(cluster: Cluster, index: WikiIndex | null): ResolvedTarget {
  const wanted = normalizeLabel(cluster.label);

  if (index) {
    let crossKind: ResolvedTarget | null = null;
    for (const page of index.pages) {
      if (page.domain !== cluster.domain) continue;
      if (page.type !== "concept" && page.type !== "entity") continue;
      const candidates = [page.title, page.name, ...page.aliases].map(normalizeLabel);
      if (!candidates.includes(wanted)) continue;
      if (page.type === cluster.kind) {
        return { mode: "update", targetPath: page.relPath, existingRelPath: page.relPath };
      }
      crossKind ??= {
        mode: "update",
        targetPath: page.relPath,
        existingRelPath: page.relPath,
        kind: page.type,
      };
    }
    if (crossKind) return crossKind;
  }

  const stem = sanitizeFilename(cluster.label) || cluster.topicKey;
  const dir = expectedDir(cluster.domain, cluster.kind);
  return { mode: "create", targetPath: path.posix.join(dir, `${stem}.md`) };
}
