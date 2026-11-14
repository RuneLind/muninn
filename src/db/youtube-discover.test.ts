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
  getDiscoverVideoDetails,
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
