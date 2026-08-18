/**
 * The `queue.yaml` writer's compare-and-swap, and the byte-shape mirror.
 *
 * The mirror is the point of the second describe: mimir's own dependency-free
 * parser (`scripts/plan-status/queue.ts`) THROWS on anything outside the shared
 * grammar and takes the whole file's ordering down with it, so muninn's writer
 * has to emit the bytes mimir's checked-in canonical fixture pins — including
 * the emptied-column-omitted case, which is what an ordinary un-rank produces.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "../gardener/util.ts";
import { __resetWikiWriteQueueForTest } from "../wiki/queue.ts";
import { parseQueueYaml, serializeQueue } from "./queue.ts";
import { writePlanQueue } from "./write.ts";
import { QUEUE_REL_PATH } from "./constants.ts";

const roots: string[] = [];

async function makeRoot(queue?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "muninn-queue-write-"));
  roots.push(root);
  await mkdir(path.join(root, "plans"), { recursive: true });
  if (queue !== undefined) await writeFile(path.join(root, QUEUE_REL_PATH), queue);
  return root;
}

const readQueueFile = (root: string) => Bun.file(path.join(root, QUEUE_REL_PATH)).text();

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("writePlanQueue", () => {
  test('bootstrap: baseHash "" against an absent file writes it', async () => {
    __resetWikiWriteQueueForTest();
    const root = await makeRoot();
    const content = serializeQueue({ ready: ["a-plan"] });
    const res = await writePlanQueue({ wikiDir: root, baseHash: "", buildContent: () => content });
    expect(res).toEqual({ outcome: "written", hash: sha256(content) });
    expect(await readQueueFile(root)).toBe(content);
  });

  test("bootstrap with a wrong base is stale — two tabs racing resolve to one", async () => {
    __resetWikiWriteQueueForTest();
    const root = await makeRoot();
    const res = await writePlanQueue({
      wikiDir: root,
      baseHash: sha256("something"),
      buildContent: () => serializeQueue({ ready: ["a-plan"] }),
    });
    expect(res.outcome).toBe("stale");
  });

  test('"" against a file that EXISTS is stale, never a clobber', async () => {
    __resetWikiWriteQueueForTest();
    const existing = serializeQueue({ ready: ["already-here"] });
    const root = await makeRoot(existing);
    const res = await writePlanQueue({
      wikiDir: root,
      baseHash: "",
      buildContent: () => serializeQueue({ ready: ["a-plan"] }),
    });
    expect(res.outcome).toBe("stale");
    expect(await readQueueFile(root)).toBe(existing);
  });

  test("consecutive writes chain off each response's hash; the older base 409s", async () => {
    __resetWikiWriteQueueForTest();
    const root = await makeRoot();
    let hash = "";
    for (const slugs of [["a"], ["a", "b"], ["b", "a"]]) {
      const content = serializeQueue({ ready: slugs });
      const res = await writePlanQueue({ wikiDir: root, baseHash: hash, buildContent: () => content });
      expect(res.outcome).toBe("written");
      hash = (res as { hash: string }).hash;
      expect(hash).toBe(sha256(await readQueueFile(root)));
    }
    const stale = await writePlanQueue({
      wikiDir: root,
      baseHash: "",
      buildContent: () => serializeQueue({ ready: ["c"] }),
    });
    expect(stale.outcome).toBe("stale");
  });

  test("the same bytes are a noop echoing the unchanged hash", async () => {
    __resetWikiWriteQueueForTest();
    const content = serializeQueue({ ready: ["a-plan"] });
    const root = await makeRoot(content);
    const res = await writePlanQueue({ wikiDir: root, baseHash: sha256(content), buildContent: () => content });
    expect(res).toEqual({ outcome: "noop", hash: sha256(content) });
  });

  test('an empty order DELETES the file and reports hash ""', async () => {
    __resetWikiWriteQueueForTest();
    const content = serializeQueue({ ready: ["a-plan"] });
    const root = await makeRoot(content);
    const res = await writePlanQueue({ wikiDir: root, baseHash: sha256(content), buildContent: () => "" });
    expect(res).toEqual({ outcome: "deleted", hash: "" });
    expect(await Bun.file(path.join(root, QUEUE_REL_PATH)).exists()).toBe(false);
    // …and the hash it handed back is a valid base for the next write.
    const again = await writePlanQueue({ wikiDir: root, baseHash: "", buildContent: () => serializeQueue({ ready: ["a"] }) });
    expect(again.outcome).toBe("written");
  });

  test("an UNREADABLE file refuses rather than clobbering an ordering on disk", async () => {
    __resetWikiWriteQueueForTest();
    const root = await makeRoot();
    // A directory where the file belongs: readable-as-absent to a naive check,
    // and the one state the reader reports as a null hash.
    await mkdir(path.join(root, QUEUE_REL_PATH), { recursive: true });
    const res = await writePlanQueue({
      wikiDir: root,
      baseHash: "",
      buildContent: () => serializeQueue({ ready: ["a-plan"] }),
    });
    expect(res.outcome).toBe("stale");
    expect((res as { reason: string }).reason).toContain("could not be read");
  });

  test("a readonly instance refuses before anything is opened", async () => {
    __resetWikiWriteQueueForTest();
    const root = await makeRoot();
    const res = await writePlanQueue({
      wikiDir: root,
      baseHash: "",
      buildContent: () => serializeQueue({ ready: ["a-plan"] }),
      isReadonly: () => true,
    });
    expect(res.outcome).toBe("forbidden");
    expect(await Bun.file(path.join(root, QUEUE_REL_PATH)).exists()).toBe(false);
  });
});

const canonical = await Bun.file(
  path.join(import.meta.dir, "fixtures", "queue.canonical.yaml"),
).text();

describe("byte-shape mirror against mimir's canonical fixture", () => {
  test("serializeQueue emits the fixture's exact bytes", () => {
    // Deliberately in a DIFFERENT key order than the file: the emitter owns the
    // order, so a client's object shape cannot move the bytes.
    const out = serializeQueue({
      blocked: ["muninn-maturity-improvements"],
      ready: ["claude-usage-codex-view"],
      proposed: ["muninn-plan-board", "huginn-fetcher-data-hygiene"],
    });
    expect(out).toBe(canonical);
  });

  test("the emptied column is OMITTED, not written as `in-flight: []`", () => {
    expect(canonical).not.toContain("in-flight");
    const order = parseQueueYaml(canonical).order;
    expect(order["in-flight"]).toBeUndefined();
    // Un-ranking the last card in a column is an ordinary drag: it must produce
    // the omitted shape, which is the one mimir's strict parser accepts.
    expect(serializeQueue({ ...order, ready: [] })).toBe(
      canonical.replace("ready:\n  - claude-usage-codex-view\n", ""),
    );
  });

  test("the fixture round-trips through muninn's parser unchanged", () => {
    const parsed = parseQueueYaml(canonical);
    expect(parsed.warnings).toEqual([]);
    expect(serializeQueue(parsed.order)).toBe(canonical);
  });
});
