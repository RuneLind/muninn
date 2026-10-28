/**
 * An in-memory `StaleProposalStore` with the database's supersede semantics
 * (`supersedeStaleCheckGroup`): the live set must match, a page another live
 * grouped row holds refuses, the group number never repeats. For the Send
 * tests and the route tests; `src/db/wiki-proposals.test.ts` runs the real one.
 */
import type { StaleProposalStore } from "../gardener/stale-proposals.ts";
import { staleCheckGroupNumber, type LiveGroupedRow, type WikiProposal } from "../db/wiki-proposals.ts";

export function memoryStaleProposalStore(): StaleProposalStore & { rows: WikiProposal[] } {
  const rows: WikiProposal[] = [];
  const live = (r: WikiProposal) => r.status === "draft" || r.status === "approved";
  let id = 0;
  return {
    rows,
    async byChanged(wiki, changed) {
      return rows.filter((r) => r.wikiName === wiki && r.kind === "stale-check" && r.staleMeta?.changed === changed);
    },
    async liveGrouped(wiki) {
      return rows.filter((r) => r.wikiName === wiki && r.groupKey && live(r)).map((r): LiveGroupedRow => ({ id: r.id, groupKey: r.groupKey!, targetPath: r.targetPath, kind: r.kind, status: r.status }));
    },
    async liveStaleCheck(wiki) {
      return rows.filter((r) => r.wikiName === wiki && r.kind === "stale-check" && live(r));
    },
    async supersede({ wikiName, changed, expectedLiveIds, rows: add }) {
      const mine = rows.filter((r) => r.wikiName === wikiName && r.kind === "stale-check" && r.staleMeta?.changed === changed);
      const expected = new Set(expectedLiveIds);
      const liveMine = mine.filter(live);
      if (liveMine.length !== expected.size || liveMine.some((r) => !expected.has(r.id) || r.status !== "draft")) return { outcome: "conflict", reason: "changed meanwhile" };
      const held = rows.find((r) => r.wikiName === wikiName && r.groupKey && live(r) && !expected.has(r.id) && add.some((a) => a.targetPath === r.targetPath));
      if (held) return { outcome: "held", targetPath: held.targetPath, groupKey: held.groupKey!, kind: held.kind };
      const n = Math.max(0, ...mine.map((r) => staleCheckGroupNumber(r.groupKey))) + 1;
      const groupKey = `stale-check:${changed}:${n}`;
      for (const r of liveMine) r.status = "stale";
      const inserted = add.map((a): WikiProposal => ({
        id: `r${++id}`,
        botName: a.botName,
        wikiName: a.wikiName ?? null,
        topicKey: a.topicKey,
        groupKey,
        lintMeta: null,
        staleMeta: a.staleMeta ?? null,
        kind: a.kind,
        mode: a.mode,
        targetPath: a.targetPath,
        baseHash: a.baseHash ?? null,
        draft: a.draft,
        sourceDocs: a.sourceDocs,
        rationale: a.rationale ?? null,
        containedLinks: null,
        relatedPages: a.relatedPages ?? null,
        status: "draft",
        createdAt: Date.now(),
        resolvedAt: null,
      }));
      rows.push(...inserted);
      return { outcome: "sent", groupKey, inserted, retired: liveMine.length };
    },
  };
}
