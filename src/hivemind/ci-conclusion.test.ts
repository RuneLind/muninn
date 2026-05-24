import { test, expect, describe } from "bun:test";
import {
  parseGithubRunUrl,
  isConfirmedGreen,
  fetchCiConclusion,
  type GhRunner,
} from "./ci-conclusion.ts";

describe("parseGithubRunUrl", () => {
  test("extracts repo + runId from an actions run URL", () => {
    expect(parseGithubRunUrl("https://github.com/navikt/melosys-api/actions/runs/123456789")).toEqual({
      repo: "navikt/melosys-api",
      runId: "123456789",
    });
  });

  test("finds the URL embedded in freeform reply text", () => {
    const text = "e2e passed! See https://github.com/capraconsulting/huginn/actions/runs/42 for details. <!-- e2e: green run:ab12cd34 -->";
    expect(parseGithubRunUrl(text)).toEqual({ repo: "capraconsulting/huginn", runId: "42" });
  });

  test("tolerates a trailing /job/<id> or query string", () => {
    expect(parseGithubRunUrl("https://github.com/o/r/actions/runs/99/job/555")).toEqual({ repo: "o/r", runId: "99" });
    expect(parseGithubRunUrl("https://github.com/o/r/actions/runs/99?check_suite_focus=true")).toEqual({ repo: "o/r", runId: "99" });
  });

  test("returns null when there is no run URL", () => {
    expect(parseGithubRunUrl("no link here")).toBeNull();
    expect(parseGithubRunUrl("https://github.com/o/r/pull/12")).toBeNull();
  });
});

describe("isConfirmedGreen", () => {
  test("true only when completed + success", () => {
    expect(isConfirmedGreen({ status: "completed", conclusion: "success", repo: "o/r", runId: "1" })).toBe(true);
  });
  test("false for in-progress, failure, or null", () => {
    expect(isConfirmedGreen({ status: "in_progress", conclusion: null, repo: "o/r", runId: "1" })).toBe(false);
    expect(isConfirmedGreen({ status: "completed", conclusion: "failure", repo: "o/r", runId: "1" })).toBe(false);
    expect(isConfirmedGreen(null)).toBe(false);
  });
});

describe("fetchCiConclusion", () => {
  const okRunner = (out: object): GhRunner => async () => ({ exitCode: 0, stdout: JSON.stringify(out), stderr: "" });

  test("parses a successful gh run view", async () => {
    const c = await fetchCiConclusion(
      "https://github.com/navikt/melosys-api/actions/runs/7",
      okRunner({ conclusion: "success", status: "completed" }),
    );
    expect(c).toEqual({ conclusion: "success", status: "completed", repo: "navikt/melosys-api", runId: "7" });
    expect(isConfirmedGreen(c)).toBe(true);
  });

  test("reports in-progress (conclusion null) without confirming green", async () => {
    const c = await fetchCiConclusion(
      "https://github.com/o/r/actions/runs/7",
      okRunner({ conclusion: null, status: "in_progress" }),
    );
    expect(isConfirmedGreen(c)).toBe(false);
  });

  test("returns null (gate closed) when the URL is not a run URL", async () => {
    let called = false;
    const runner: GhRunner = async () => { called = true; return { exitCode: 0, stdout: "{}", stderr: "" }; };
    expect(await fetchCiConclusion("not a url", runner)).toBeNull();
    expect(called).toBe(false); // never even shells out
  });

  test("returns null when gh exits non-zero", async () => {
    const runner: GhRunner = async () => ({ exitCode: 1, stdout: "", stderr: "could not find run" });
    expect(await fetchCiConclusion("https://github.com/o/r/actions/runs/7", runner)).toBeNull();
  });

  test("returns null when gh output is unparseable JSON", async () => {
    const runner: GhRunner = async () => ({ exitCode: 0, stdout: "not json", stderr: "" });
    expect(await fetchCiConclusion("https://github.com/o/r/actions/runs/7", runner)).toBeNull();
  });
});
