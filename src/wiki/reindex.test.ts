import { test, expect, describe } from "bun:test";
import {
  reindexStateFromOutcome,
  statusResultFromOutcome,
  buildReindexResponse,
  buildReindexStatusResponse,
  type PostOutcome,
  type StatusOutcome,
} from "./reindex.ts";

describe("reindexStateFromOutcome", () => {
  test("ok → started", () => {
    expect(reindexStateFromOutcome({ kind: "ok" })).toBe("started");
  });
  test("conflict (huginn 409) → already-running, NOT error", () => {
    expect(reindexStateFromOutcome({ kind: "conflict" })).toBe("already-running");
  });
  test("error → error", () => {
    expect(reindexStateFromOutcome({ kind: "error", error: "unreachable" })).toBe("error");
  });
});

describe("statusResultFromOutcome", () => {
  test("passes through huginn's status", () => {
    expect(statusResultFromOutcome("wiki", { kind: "ok", status: "running" })).toEqual({
      name: "wiki",
      status: "running",
    });
  });
  test("carries a failed status's error text", () => {
    expect(
      statusResultFromOutcome("wiki", { kind: "ok", status: "failed", error: "boom" }),
    ).toEqual({ name: "wiki", status: "failed", error: "boom" });
  });
  test("a failed status fetch degrades to unknown + error", () => {
    expect(statusResultFromOutcome("wiki", { kind: "error", error: "unreachable" })).toEqual({
      name: "wiki",
      status: "unknown",
      error: "unreachable",
    });
  });
});

describe("buildReindexResponse", () => {
  test("multi-collection fan-out: mixed started / already-running / error", async () => {
    const outcomes: Record<string, PostOutcome> = {
      wiki: { kind: "ok" },
      "wiki-life": { kind: "conflict" },
      "wiki-broken": { kind: "error", error: "unreachable" },
    };
    const res = await buildReindexResponse(
      ["wiki", "wiki-life", "wiki-broken"],
      async (c) => outcomes[c]!,
    );
    expect(res.collections).toEqual([
      { name: "wiki", state: "started" },
      { name: "wiki-life", state: "already-running" },
      { name: "wiki-broken", state: "error", error: "unreachable" },
    ]);
  });

  test("unreachable huginn → per-collection error entries (never throws)", async () => {
    const res = await buildReindexResponse(["wiki", "wiki-life"], async (c) => ({
      kind: "error",
      error: "Knowledge API unreachable",
    }));
    expect(res.collections).toEqual([
      { name: "wiki", state: "error", error: "Knowledge API unreachable" },
      { name: "wiki-life", state: "error", error: "Knowledge API unreachable" },
    ]);
  });

  test("posts sequentially in collection order", async () => {
    const seen: string[] = [];
    await buildReindexResponse(["a", "b", "c"], async (c) => {
      seen.push(c);
      return { kind: "ok" };
    });
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("empty collections → empty result", async () => {
    const res = await buildReindexResponse([], async () => ({ kind: "ok" }));
    expect(res.collections).toEqual([]);
  });
});

describe("buildReindexStatusResponse", () => {
  test("multi-collection fan-out incl. an unknown (failed fetch) entry", async () => {
    const outcomes: Record<string, StatusOutcome> = {
      wiki: { kind: "ok", status: "running" },
      "wiki-life": { kind: "ok", status: "succeeded" },
      "wiki-broken": { kind: "error", error: "timeout" },
    };
    const res = await buildReindexStatusResponse(
      ["wiki", "wiki-life", "wiki-broken"],
      async (c) => outcomes[c]!,
    );
    expect(res.collections).toEqual([
      { name: "wiki", status: "running" },
      { name: "wiki-life", status: "succeeded" },
      { name: "wiki-broken", status: "unknown", error: "timeout" },
    ]);
  });

  test("empty collections → empty result", async () => {
    const res = await buildReindexStatusResponse([], async () => ({ kind: "ok", status: "idle" }));
    expect(res.collections).toEqual([]);
  });
});
