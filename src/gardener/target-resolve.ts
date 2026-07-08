/**
 * Target-resolve stage — decide whether a cluster becomes a NEW page or an
 * UPDATE to an existing one, using the LOCAL wiki store as the oracle (fresh +
 * exact, immune to huginn index staleness). Huginn search scores are never
 * consulted for the mode decision (rank-based, not confidence).
 */

import path from "node:path";
import type { Cluster, ResolvedTarget } from "./types.ts";
import type { WikiIndex } from "../wiki/store.ts";

/** Normalize a title/alias/label for near-match comparison. */
export function normalizeLabel(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The wiki dir a cluster's new page belongs in, given its domain + kind. */
export function expectedDir(domain: "ai" | "life", kind: "concept" | "entity"): string {
  const sub = kind === "concept" ? "concepts" : "entities";
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
 */
export function resolveTarget(cluster: Cluster, index: WikiIndex | null): ResolvedTarget {
  const wanted = normalizeLabel(cluster.label);

  if (index) {
    for (const page of index.pages) {
      const candidates = [page.title, page.name, ...page.aliases].map(normalizeLabel);
      if (candidates.includes(wanted)) {
        return { mode: "update", targetPath: page.relPath, existingRelPath: page.relPath };
      }
    }
  }

  const stem = sanitizeFilename(cluster.label) || cluster.topicKey;
  const dir = expectedDir(cluster.domain, cluster.kind);
  return { mode: "create", targetPath: path.posix.join(dir, `${stem}.md`) };
}
