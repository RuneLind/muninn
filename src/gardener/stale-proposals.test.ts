/**
 * Send to Gardener (D20) over an in-memory proposal store with the database's
 * supersede semantics; `src/db/wiki-proposals.test.ts` runs the real
 * transaction. Synthetic pages in a temp dir.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inReviewByChanged, sendStaleFix, staleEditHash } from "./stale-proposals.ts";
import { memoryStaleProposalStore as memoryStore } from "../test/stale-proposal-store.ts";
import type { StaleFixEdit } from "../wiki/stale-fix.ts";
import type { WikiIndex, WikiPageMeta } from "../wiki/store.ts";
import { sha256 } from "./util.ts";
import { testTempDir } from "../test/temp-dir.ts";

const PAGES: Record<string, string> = { hub: "hub.md" };
const index = { resolve: (t: string) => (PAGES[t] ? ({ relPath: PAGES[t] } as WikiPageMeta) : undefined) } as unknown as WikiIndex;
const page = (body: string) => `---\ntitle: Note\n---\n\n${body}\n`;
const edit = (pageRel: string, old: string, text: string): StaleFixEdit => ({ kind: "passage", page: pageRel, link: "hub.md", old, text, variant: "new", reason: `${pageRel} moved` });

describe("sendStaleFix (D20)", () => {
  let root = "";
  let store = memoryStore();
  const A = "notes/a.md";
  const B = "notes/b.md";
  const A_TEXT = page("The pin in [[hub]] landed on 23.05.\n\nThe lock in [[hub]] is open PR.");
  const B_TEXT = page("Since [[hub]] moved on 2.06 the pin is draft.");

  beforeEach(async () => {
    root = await testTempDir(path.join(tmpdir(), "stale-send-"));
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, A), A_TEXT);
    await writeFile(path.join(root, B), B_TEXT);
    store = memoryStore();
  });

  const send = (e: StaleFixEdit) => sendStaleFix({ wiki: "w", wikiDir: root, index, changed: "hub.md", edit: e, store });

  test("the first Send makes group 1: one row, its draft, base hash, keys and relatedPages []", async () => {
    const e = edit(A, "landed on 23.05", "landed on 18.06");
    const out = await send(e);
    expect(out).toEqual({ outcome: "sent", groupKey: "stale-check:hub.md:1", supersedes: null, pages: [A], fixes: 1, dropped: [] });
    const [row] = store.rows;
    expect(row).toMatchObject({
      kind: "stale-check",
      mode: "update",
      targetPath: A,
      groupKey: "stale-check:hub.md:1",
      topicKey: `stale-check:hub.md:${A}:${staleEditHash([e])}`,
      baseHash: sha256(A_TEXT),
      draft: A_TEXT.replace("landed on 23.05", "landed on 18.06"),
      relatedPages: [],
      staleMeta: { changed: "hub.md", edits: [e], supersedes: null },
    });
  });

  test("a second Send retires group 1 (stale) and inserts group 2 holding both pages — one live card", async () => {
    await send(edit(A, "landed on 23.05", "landed on 18.06"));
    const out = await send(edit(B, "the pin is draft", "the pin is shipped"));
    expect(out.outcome === "sent" && out.groupKey).toBe("stale-check:hub.md:2");
    expect(out.outcome === "sent" && out.supersedes).toBe("stale-check:hub.md:1");
    const live = store.rows.filter((r) => r.status === "draft");
    expect(live.map((r) => [r.groupKey, r.targetPath])).toEqual([["stale-check:hub.md:2", A], ["stale-check:hub.md:2", B]]);
    expect(store.rows.filter((r) => r.status === "stale").map((r) => r.groupKey)).toEqual(["stale-check:hub.md:1"]);
  });

  test("two edits to one page merge into one row keyed by the hash of its edit list", async () => {
    const e1 = edit(A, "landed on 23.05", "landed on 18.06");
    const e2 = edit(A, "is open PR", "is merged");
    await send(e1);
    await send(e2);
    const live = store.rows.filter((r) => r.status === "draft");
    expect(live).toHaveLength(1);
    expect(live[0]!.topicKey).toBe(`stale-check:hub.md:${A}:${staleEditHash([e1, e2])}`);
    expect(live[0]!.draft).toBe(page("The pin in [[hub]] landed on 18.06.\n\nThe lock in [[hub]] is merged."));
  });

  test("each row is redrafted on the page's current bytes; an old edit that no longer places is dropped and said", async () => {
    await send(edit(A, "landed on 23.05", "landed on 18.06"));
    // Someone edits page A by hand meanwhile.
    const edited = A_TEXT.replace("landed on 23.05", "landed in May");
    await writeFile(path.join(root, A), edited);
    const out = await send(edit(B, "the pin is draft", "the pin is shipped"));
    expect(out.outcome === "sent" && out.dropped).toEqual([{ page: A, old: "landed on 23.05", reason: "The text to replace is no longer in the passage exactly once." }]);
    expect(store.rows.filter((r) => r.status === "draft").map((r) => r.targetPath)).toEqual([B]);
  });

  test("a page another live group holds refuses the Send, and nothing changes", async () => {
    store.rows.push({ id: "lint1", botName: "w", wikiName: "w", topicKey: `lint:x:1:${A}`, groupKey: "lint:x:1", lintMeta: null, kind: "lint", mode: "update", targetPath: A, baseHash: "h", draft: "", sourceDocs: [], rationale: null, containedLinks: null, relatedPages: null, status: "draft", createdAt: 0, resolvedAt: null });
    const out = await send(edit(A, "landed on 23.05", "landed on 18.06"));
    expect(out).toMatchObject({ outcome: "refused", status: 409 });
    expect(out.outcome === "refused" && out.error).toContain("held by another Gardener card");
    expect(store.rows).toHaveLength(1);
  });

  test("a fix already on the live card, or one whose own edit no longer places, refuses", async () => {
    const e = edit(A, "landed on 23.05", "landed on 18.06");
    await send(e);
    expect(await send(e)).toEqual({ outcome: "refused", status: 409, error: "This fix is already in review in the Gardener." });
    expect(await send(edit(B, "not on the page", "x"))).toEqual({ outcome: "refused", status: 409, error: "The text to replace is no longer in the passage exactly once." });
    expect(store.rows.filter((r) => r.status === "draft")).toHaveLength(1);
  });

  test("a group being applied refuses a Send", async () => {
    await send(edit(A, "landed on 23.05", "landed on 18.06"));
    store.rows[0]!.status = "approved";
    expect(await send(edit(B, "the pin is draft", "x"))).toMatchObject({ outcome: "refused", status: 409 });
  });

  test("inReviewByChanged counts the live card's edits per changed page", async () => {
    await send(edit(A, "landed on 23.05", "landed on 18.06"));
    await send(edit(A, "is open PR", "is merged"));
    await send(edit(B, "the pin is draft", "the pin is shipped"));
    const m = inReviewByChanged(store.rows);
    expect(m.get("hub.md")).toEqual({
      fixes: 3,
      groupKey: "stale-check:hub.md:3",
      edits: [
        { kind: "passage", page: A, link: "hub.md", old: "landed on 23.05" },
        { kind: "passage", page: A, link: "hub.md", old: "is open PR" },
        { kind: "passage", page: B, link: "hub.md", old: "the pin is draft" },
      ],
    });
  });
});
