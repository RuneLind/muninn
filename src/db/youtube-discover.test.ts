/**
 * `youtube_discover_runs` / `youtube_discover_hits` (migration 088) against the
 * real test database: a run and its hits in rank order, the newest run per seed
 * as the shelf, per-video state and details across shelves, the known set.
 * Invented ids and titles only (public repo).
 */
import { describe, expect, test } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  getDiscoverKnownVideoIds,
  getDiscoverRetrySeeds,
  getDiscoverVideoDetails,
  getLatestDiscoverRunTimes,
  getLatestDiscoverRunAt,
  listDiscoverShelfPage,
  listDiscoverShelves,
  saveDiscoverRun,
  saveDiscoverVideoDetails,
  setDiscoverVideoState,
  type DiscoverHitInput,
  type DiscoverRunInput,
  type DiscoverVideoDetails,
} from "./youtube-discover.ts";

setupTestDb();

const run = (over: Partial<DiscoverRunInput> = {}): DiscoverRunInput => ({
  seedDocId: "ai/agents/Invented seed.md",
  seedTitle: "Invented seed",
  seedVideoId: "seedseed001",
  seedCategory: "ai/agents",
  seedDate: "2026-03-22",
  queries: [{ query: "agent evals", why: "same topic" }],
  searched: 10,
  known: 2,
  origin: "reader",
  botName: "invented",
  ...over,
});
const hit = (videoId: string, score: number, over: Partial<DiscoverHitInput> = {}): DiscoverHitInput => ({
  videoId,
  title: `Video ${videoId}`,
  channel: "Invented",
  durationSec: 615.4,
  viewCount: 1234,
  score,
  why: "invented reason",
  query: "agent evals",
  ...over,
});
const DETAILS: DiscoverVideoDetails = {
  description: "Invented description",
  chapters: [{ start: 0, title: "Intro" }],
  likeCount: 5,
  viewCount: 1300,
  uploadDate: "20260301",
  channelFollowerCount: null,
  tags: [],
};

describe("saveDiscoverRun / listDiscoverShelves", () => {
  test("a run comes back as a shelf with its fields and hits in rank order", async () => {
    const id = await saveDiscoverRun(run(), [hit("vidAAAAAAA1", 0.9), hit("vidBBBBBBB2", 0.6, { channel: null, durationSec: null, viewCount: null })]);
    const [shelf] = await listDiscoverShelves();
    expect(shelf).toMatchObject({
      runId: id,
      seedSource: "youtube",
      seedDocId: "ai/agents/Invented seed.md",
      seedVideoId: "seedseed001",
      seedCategory: "ai/agents",
      seedDate: "2026-03-22",
      queries: [{ query: "agent evals", why: "same topic" }],
      searched: 10,
      known: 2,
      origin: "reader",
    });
    expect(typeof shelf!.createdAt).toBe("number");
    expect(shelf!.hits.map((h) => [h.videoId, h.rank, h.state, h.durationSec, h.details])).toEqual([
      ["vidAAAAAAA1", 1, "new", 615, null],
      ["vidBBBBBBB2", 2, "new", null, null],
    ]);
    expect(shelf!.hits[1]!.channel).toBeNull();
  });

  test("one shelf per seed: the newest run wins; seeds newest first", async () => {
    await saveDiscoverRun(run({ seedDocId: "a.md" }), [hit("vidAAAAAAA1", 0.9)]);
    await saveDiscoverRun(run({ seedDocId: "b.md" }), [hit("vidBBBBBBB2", 0.9)]);
    await saveDiscoverRun(run({ seedDocId: "a.md" }), [hit("vidCCCCCCC3", 0.9)]);
    const shelves = await listDiscoverShelves();
    expect(shelves.map((s) => [s.seedDocId, s.hits.map((h) => h.videoId)])).toEqual([
      ["a.md", ["vidCCCCCCC3"]],
      ["b.md", ["vidBBBBBBB2"]],
    ]);
  });

  test("the same video twice in one run is stored once, ranks without a gap", async () => {
    await saveDiscoverRun(run(), [hit("vidAAAAAAA1", 0.9), hit("vidAAAAAAA1", 0.8), hit("vidBBBBBBB2", 0.7)]);
    const [shelf] = await listDiscoverShelves();
    expect(shelf!.hits.map((h) => [h.videoId, h.rank, h.score])).toEqual([
      ["vidAAAAAAA1", 1, 0.9],
      ["vidBBBBBBB2", 2, 0.7],
    ]);
  });

  test("an empty run is a shelf with no hits", async () => {
    await saveDiscoverRun(run(), []);
    const [shelf] = await listDiscoverShelves();
    expect(shelf!.hits).toEqual([]);
  });

  test("the origin CHECK refuses an unknown origin", async () => {
    await expect(saveDiscoverRun(run({ origin: "nope" as never }), [])).rejects.toThrow();
  });
});

describe("per-video state and details", () => {
  test("a state write reaches the video on every shelf; 0 for an unknown video", async () => {
    await saveDiscoverRun(run({ seedDocId: "a.md" }), [hit("vidAAAAAAA1", 0.9)]);
    await saveDiscoverRun(run({ seedDocId: "b.md" }), [hit("vidAAAAAAA1", 0.7), hit("vidBBBBBBB2", 0.6)]);
    expect(await setDiscoverVideoState("vidAAAAAAA1", "later")).toBe(2);
    expect(await setDiscoverVideoState("vidZZZZZZZ9", "later")).toBe(0);
    const shelves = await listDiscoverShelves();
    const states = shelves.flatMap((s) => s.hits.map((h) => `${s.seedDocId}:${h.videoId}:${h.state}`)).sort();
    expect(states).toEqual(["a.md:vidAAAAAAA1:later", "b.md:vidAAAAAAA1:later", "b.md:vidBBBBBBB2:new"]);
  });

  test("a new run's hit takes the video's state and details from its earlier row", async () => {
    await saveDiscoverRun(run({ seedDocId: "a.md" }), [hit("vidAAAAAAA1", 0.9)]);
    await setDiscoverVideoState("vidAAAAAAA1", "later");
    await saveDiscoverVideoDetails("vidAAAAAAA1", DETAILS);
    await saveDiscoverRun(run({ seedDocId: "b.md" }), [hit("vidAAAAAAA1", 0.8)]);
    const b = (await listDiscoverShelves()).find((s) => s.seedDocId === "b.md")!;
    expect(b.hits[0]!.state).toBe("later");
    expect(b.hits[0]!.details).toEqual(DETAILS);
  });

  test("details: undefined for no row, null before a probe, the cached value after", async () => {
    expect(await getDiscoverVideoDetails("vidAAAAAAA1")).toBeUndefined();
    await saveDiscoverRun(run(), [hit("vidAAAAAAA1", 0.9)]);
    expect(await getDiscoverVideoDetails("vidAAAAAAA1")).toBeNull();
    await saveDiscoverVideoDetails("vidAAAAAAA1", DETAILS);
    expect(await getDiscoverVideoDetails("vidAAAAAAA1")).toEqual(DETAILS);
    const [row] = await getDb()`SELECT jsonb_typeof(details) AS t FROM youtube_discover_hits WHERE video_id = 'vidAAAAAAA1'`;
    expect(row!.t).toBe("object");
  });

  test("the known set is the dismissed and queued videos only", async () => {
    await saveDiscoverRun(run(), [hit("vidAAAAAAA1", 0.9), hit("vidBBBBBBB2", 0.8), hit("vidCCCCCCC3", 0.7), hit("vidDDDDDDD4", 0.6)]);
    await setDiscoverVideoState("vidAAAAAAA1", "dismissed");
    await setDiscoverVideoState("vidBBBBBBB2", "queued");
    await setDiscoverVideoState("vidCCCCCCC3", "later");
    expect([...(await getDiscoverKnownVideoIds())].sort()).toEqual(["vidAAAAAAA1", "vidBBBBBBB2"]);
  });

  test("a state write during another seed's save reaches the new shelf's row too", async () => {
    await saveDiscoverRun(run({ seedDocId: "a.md" }), [hit("vidAAAAAAA1", 0.9)]);
    let write: Promise<number> | undefined;
    await saveDiscoverRun(run({ seedDocId: "b.md" }), [hit("vidAAAAAAA1", 0.8)], {
      // Inside b's transaction, after its rows are written and before it commits.
      beforeCommit: async () => {
        write = setDiscoverVideoState("vidAAAAAAA1", "dismissed");
        await Bun.sleep(50);
      },
    });
    await write;
    const states = (await listDiscoverShelves()).map((s) => `${s.seedDocId}:${s.hits[0]!.state}`).sort();
    expect(states).toEqual(["a.md:dismissed", "b.md:dismissed"]);
  });

  test("the state CHECK refuses an unknown state", async () => {
    await saveDiscoverRun(run(), [hit("vidAAAAAAA1", 0.9)]);
    await expect(setDiscoverVideoState("vidAAAAAAA1", "summarized" as never)).rejects.toThrow();
  });
});

describe("getLatestDiscoverRunTimes (PR 3)", () => {
  test("the newest run per asked seed, of the asked source only", async () => {
    const a1 = await saveDiscoverRun(run({ seedDocId: "a/One.md" }), [hit("vidAAAAAAA1", 0.9)]);
    const a2 = await saveDiscoverRun(run({ seedDocId: "a/One.md" }), [hit("vidAAAAAAA1", 0.9)]);
    const b = await saveDiscoverRun(run({ seedDocId: "a/Two.md" }), [hit("vidBBBBBBB2", 0.9)]);
    const other = await saveDiscoverRun(run({ seedDocId: "a/Three.md", seedSource: "vimeo" }), [hit("vidCCCCCCC3", 0.9)]);
    await getDb()`UPDATE youtube_discover_runs SET created_at = '2026-11-01T10:00:00Z' WHERE id = ${a1}`;
    await getDb()`UPDATE youtube_discover_runs SET created_at = '2026-11-08T10:00:00Z' WHERE id = ${a2}`;
    await getDb()`UPDATE youtube_discover_runs SET created_at = '2026-11-05T10:00:00Z' WHERE id = ${b}`;
    await getDb()`UPDATE youtube_discover_runs SET created_at = '2026-11-09T10:00:00Z' WHERE id = ${other}`;

    const got = await getLatestDiscoverRunTimes(["a/One.md", "a/Two.md", "a/Three.md", "a/Never.md"]);
    expect([...got.entries()].sort()).toEqual([
      ["a/One.md", Date.parse("2026-11-08T10:00:00Z")],
      ["a/Two.md", Date.parse("2026-11-05T10:00:00Z")],
    ]);
    expect(await getLatestDiscoverRunTimes([])).toEqual(new Map());
  });
});

describe("getLatestDiscoverRunAt (fix round 2 batch 1)", () => {
  test("the newest run of one origin for one bot", async () => {
    const a = await saveDiscoverRun(run({ seedDocId: "w/One.md", origin: "watcher", botName: "bot-a" }), [hit("vidWWWWWWW1", 0.9)]);
    const b = await saveDiscoverRun(run({ seedDocId: "w/Two.md", origin: "watcher", botName: "bot-a" }), [hit("vidWWWWWWW2", 0.9)]);
    const page = await saveDiscoverRun(run({ seedDocId: "w/Three.md", origin: "page", botName: "bot-a" }), [hit("vidWWWWWWW3", 0.9)]);
    const other = await saveDiscoverRun(run({ seedDocId: "w/Four.md", origin: "watcher", botName: "bot-b" }), [hit("vidWWWWWWW4", 0.9)]);
    await getDb()`UPDATE youtube_discover_runs SET created_at = '2026-11-01T12:00:00Z' WHERE id = ${a}`;
    await getDb()`UPDATE youtube_discover_runs SET created_at = '2026-11-07T12:00:00Z' WHERE id = ${b}`;
    await getDb()`UPDATE youtube_discover_runs SET created_at = '2026-11-09T12:00:00Z' WHERE id = ${page}`;
    await getDb()`UPDATE youtube_discover_runs SET created_at = '2026-11-10T12:00:00Z' WHERE id = ${other}`;
    expect(await getLatestDiscoverRunAt("watcher", "bot-a")).toBe(Date.parse("2026-11-07T12:00:00Z"));
    expect(await getLatestDiscoverRunAt("watcher", "bot-none")).toBeNull();
  });
});

describe("failed runs and the shelf window (architecture review 2026-11-16, F14 + F18)", () => {
  const at = (id: string, iso: string) => getDb()`UPDATE youtube_discover_runs SET created_at = ${iso} WHERE id = ${id}`;

  test("a run stores its failed count; absent is 0", async () => {
    await saveDiscoverRun(run({ seedDocId: "f/Clean.md" }), [hit("vidFFFFFFF1", 0.9)]);
    await saveDiscoverRun(run({ seedDocId: "f/Failed.md", failed: 3 }), []);
    const shelves = await listDiscoverShelves();
    const by = Object.fromEntries(shelves.map((s) => [s.seedDocId, s.failed]));
    expect(by).toEqual({ "f/Clean.md": 0, "f/Failed.md": 3 });
  });

  test("retry seeds: a seed whose newest run failed, with its failed runs since the last complete one", async () => {
    const ok1 = await saveDiscoverRun(run({ seedDocId: "r/A.md" }), []);
    const f1 = await saveDiscoverRun(run({ seedDocId: "r/A.md", failed: 2 }), []);
    const f2 = await saveDiscoverRun(run({ seedDocId: "r/A.md", failed: 1 }), []);
    const old = await saveDiscoverRun(run({ seedDocId: "r/A.md", failed: 5 }), []);
    await at(old, "2026-10-01T00:00:00Z"); // before the complete run: not counted
    await at(ok1, "2026-11-01T00:00:00Z");
    await at(f1, "2026-11-08T00:00:00Z");
    await at(f2, "2026-11-15T00:00:00Z");
    // Recovered: its newest run is complete.
    const bf = await saveDiscoverRun(run({ seedDocId: "r/B.md", failed: 1 }), []);
    const bok = await saveDiscoverRun(run({ seedDocId: "r/B.md" }), []);
    await at(bf, "2026-11-08T00:00:00Z");
    await at(bok, "2026-11-15T00:00:00Z");
    // Never complete.
    await saveDiscoverRun(run({ seedDocId: "r/C.md", failed: 4 }), []);
    // Another source.
    await saveDiscoverRun(run({ seedDocId: "r/D.md", seedSource: "vimeo", failed: 1 }), []);
    const got = await getDiscoverRetrySeeds();
    expect([...got.entries()].sort()).toEqual([
      ["r/A.md", 2],
      ["r/C.md", 1],
    ]);
  });

  test("the page reads 40 shelves, counts the rest, and keeps an older shelf holding a Later video", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 45; i++) {
      const id = await saveDiscoverRun(run({ seedDocId: `w/Shelf ${i}.md` }), [hit(`vid${String(i).padStart(8, "0")}`, 0.9)]);
      // Shelf 1 is the newest, shelf 45 the oldest.
      await at(id, new Date(Date.parse("2026-11-20T00:00:00Z") - i * 3_600_000).toISOString());
      ids.push(id);
    }
    expect(await setDiscoverVideoState("vid00000045", "later")).toBe(1);
    const page = await listDiscoverShelfPage();
    expect(page.shelves).toHaveLength(41);
    expect(page.shelves.slice(0, 40).map((s) => s.seedDocId)).toEqual(Array.from({ length: 40 }, (_, i) => `w/Shelf ${i + 1}.md`));
    expect(page.shelves[40]!.seedDocId).toBe("w/Shelf 45.md");
    expect(page.shelves[40]!.hits[0]!.state).toBe("later");
    expect(page.hidden).toBe(4);
    expect(await listDiscoverShelfPage(50)).toMatchObject({ hidden: 0 });
  });
});
