import { test, expect } from "bun:test";
import {
  RESEARCH_PROFILES,
  RESEARCH_CORPUS,
  RESEARCH_COLLECTIONS,
  DEFAULT_PROFILE,
  resolveProfile,
  getResearchCollection,
  badgeForCollection,
} from "./corpus.ts";

test("resolveProfile: default (no arg) → ai profile", () => {
  expect(resolveProfile()).toBe(RESEARCH_PROFILES.ai!);
  expect(DEFAULT_PROFILE).toBe("ai");
});

test("resolveProfile: known names resolve to their profile", () => {
  expect(resolveProfile("ai")).toBe(RESEARCH_PROFILES.ai!);
  expect(resolveProfile("life")).toBe(RESEARCH_PROFILES.life!);
});

test("resolveProfile: unknown / empty / null falls back to the default profile", () => {
  expect(resolveProfile("bogus")).toBe(RESEARCH_PROFILES.ai!);
  expect(resolveProfile("")).toBe(RESEARCH_PROFILES.ai!);
  expect(resolveProfile(null)).toBe(RESEARCH_PROFILES.ai!);
  expect(resolveProfile(undefined)).toBe(RESEARCH_PROFILES.ai!);
});

test("RESEARCH_COLLECTIONS is the ai profile's collections (the ask.ts fallback)", () => {
  expect(RESEARCH_COLLECTIONS).toEqual(RESEARCH_PROFILES.ai!.collections);
  expect(RESEARCH_COLLECTIONS).toEqual([
    "anthropic-summaries",
    "anthropic-knowledge",
    "youtube-summaries",
    "x-articles",
    "tiktok-summaries",
    "wiki",
  ]);
});

test("RESEARCH_CORPUS is the deduped union of all profile collections", () => {
  const names = RESEARCH_CORPUS.map((c) => c.collection);
  // Every collection from every profile appears exactly once.
  const expected = new Set(Object.values(RESEARCH_PROFILES).flatMap((p) => p.collections));
  expect(new Set(names)).toEqual(expected);
  expect(names.length).toBe(expected.size); // no duplicates (shared youtube/x/tiktok)
  // wiki-life is life-only but still in the union so its citations render.
  expect(names).toContain("wiki-life");
});

test("citation metadata resolves for collections from any profile", () => {
  // tiktok-summaries + wiki-life are the new entries — both must have badges.
  expect(getResearchCollection("tiktok-summaries")?.sourceId).toBe("tiktok");
  expect(badgeForCollection("tiktok-summaries")).toBe("TikTok");
  expect(badgeForCollection("wiki-life")).toBe("Life");
  // Off-corpus collections still degrade to the collection name.
  expect(badgeForCollection("unknown-collection")).toBe("unknown-collection");
});
