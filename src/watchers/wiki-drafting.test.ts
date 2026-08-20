import { test, expect, describe } from "bun:test";
import {
  WIKI_DRAFTING_WATCHER_TYPES,
  shouldSkipWikiDraftingRun,
  wikiDraftingTarget,
  type WikiDraftingTargetDeps,
} from "./wiki-drafting.ts";
import type { WatcherType } from "../types.ts";

/**
 * The per-wiki (`WIKI_READONLY_ROOTS`) half of the drafting-watcher gate. The
 * INSTANCE half is `shouldSkipWikiDraftingRun`; this is the same question asked
 * of the root the run would draft INTO, so the manual trigger can answer at the
 * moment of the click instead of queueing a run that quietly does nothing.
 */
const deps: WikiDraftingTargetDeps = {
  botWikiDir: (bot) => (bot === "jarvis" ? "/wikis/jarvis" : undefined),
  wikiRootByName: (name) => (name === "mimir" ? "/wikis/mimir" : undefined),
  isReadonlyRoot: (root) => root === "/wikis/jarvis" || root === "/wikis/mimir",
};

/** A drafting type this resolver has no branch for. */
const FUTURE = "atlas-gardener" as unknown as WatcherType;

describe("wikiDraftingTarget", () => {
  test("a non-drafting watcher type is never the gate's business", () => {
    for (const type of ["email", "x", "anthropic", "wiki-linter", "wiki-committer"] as WatcherType[]) {
      expect(WIKI_DRAFTING_WATCHER_TYPES.has(type)).toBe(false);
      expect(wikiDraftingTarget({ type, botName: "jarvis" }, deps)).toEqual({ kind: "allow" });
    }
  });

  test("wiki-gardener is keyed on the OWNING bot's wikiDir", () => {
    expect(wikiDraftingTarget({ type: "wiki-gardener", botName: "jarvis" }, deps)).toEqual({
      kind: "readonly-root",
      root: "/wikis/jarvis",
    });
    expect(wikiDraftingTarget({ type: "wiki-gardener", botName: "melosys" }, deps)).toEqual({
      kind: "allow",
    });
  });

  test("consolidation-gardener is keyed on its config wiki, not the bot", () => {
    const w = { type: "consolidation-gardener" as WatcherType, botName: "melosys" };
    expect(wikiDraftingTarget({ ...w, config: { wiki: "mimir" } }, deps)).toEqual({
      kind: "readonly-root",
      root: "/wikis/mimir",
    });
    expect(wikiDraftingTarget({ ...w, config: { wiki: "notes" } }, deps)).toEqual({ kind: "allow" });
    // No wiki named at all: nothing to judge — the checker's own problem.
    expect(wikiDraftingTarget({ ...w, config: {} }, deps)).toEqual({ kind: "allow" });
    expect(wikiDraftingTarget(w, deps)).toEqual({ kind: "allow" });
  });

  test("a drafting type with no resolver here FAILS CLOSED, loudly", () => {
    // The regression this exists for: the resolver hardcoded the two type names,
    // so a THIRD drafting type added to the shared set would be silently allowed
    // to force-run against a read-only root. Gating on the shared set makes the
    // gap structural, and an unresolvable member refuses rather than returning
    // "allow" — the manual trigger is the one path with a human waiting for an
    // answer, so a wrong refusal is visible and a wrong allow is not.
    const withFuture: WikiDraftingTargetDeps = {
      ...deps,
      types: new Set<WatcherType>(["wiki-gardener", "consolidation-gardener", FUTURE]),
    };
    expect(
      wikiDraftingTarget({ type: FUTURE, botName: "jarvis" }, withFuture),
    ).toEqual({ kind: "unhandled" });
    // …and it is a member-of-the-set question, not a name question: the same type
    // outside the set is an ordinary watcher.
    expect(wikiDraftingTarget({ type: FUTURE, botName: "jarvis" }, deps))
      .toEqual({ kind: "allow" });
  });

  test("the instance gate still covers exactly the shared set", () => {
    expect(shouldSkipWikiDraftingRun("wiki-gardener", true)).toBe(true);
    expect(shouldSkipWikiDraftingRun("consolidation-gardener", true)).toBe(true);
    expect(shouldSkipWikiDraftingRun("wiki-linter", true)).toBe(false);
    expect(shouldSkipWikiDraftingRun("wiki-gardener", false)).toBe(false);
  });
});
