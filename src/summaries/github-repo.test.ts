import { describe, expect, test } from "bun:test";
import { formatStars, githubRepoLookup, githubRepoOf, repoDetail, withRepoDetails } from "./github-repo.ts";
import type { LinkLine } from "./links-section.ts";

/** An invented repo answer in the shape of `GET /repos/<owner>/<repo>`. */
const REPO_JSON = {
  full_name: "example/harness",
  description: "Eval-first harness for invented agents",
  language: "TypeScript",
  license: { key: "mit", name: "MIT License", spdx_id: "MIT" },
  stargazers_count: 2134,
};

function fakeFetch(answer: { status: number; body?: unknown }, seen: Array<{ url: string; auth?: string }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), ...(headers.get("authorization") ? { auth: headers.get("authorization")! } : {}) });
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const line = (url: string, detail = ""): LinkLine => ({ icon: "📦", title: "harness", url, detail, provenance: "from text" });

describe("githubRepoOf", () => {
  test("a repo, a page inside it, `.git`; not a profile, not a site page", () => {
    expect(githubRepoOf("https://github.com/example/harness")).toEqual({ owner: "example", repo: "harness" });
    expect(githubRepoOf("https://www.github.com/example/harness.git")).toEqual({ owner: "example", repo: "harness" });
    expect(githubRepoOf("https://github.com/example/harness/blob/main/README.md")).toEqual({ owner: "example", repo: "harness" });
    expect(githubRepoOf("https://github.com/example")).toBeNull();
    expect(githubRepoOf("https://github.com/topics/agents")).toBeNull();
    expect(githubRepoOf("https://gist.github.com/example/abc")).toBeNull();
    expect(githubRepoOf("https://example.org/example/harness")).toBeNull();
  });
});

describe("the detail line", () => {
  test("description, language, license, stars with the day", () => {
    expect(repoDetail(REPO_JSON, "2026-10-25")).toBe(
      "Eval-first harness for invented agents, TypeScript, MIT, ★ 2.1k on 2026-10-25",
    );
  });

  test("missing parts are left out; NOASSERTION falls back to the license name", () => {
    expect(repoDetail({ stargazers_count: 7, license: { spdx_id: "NOASSERTION", name: "Other" } }, "2026-10-25")).toBe(
      "Other, ★ 7 on 2026-10-25",
    );
  });

  test("star counts", () => {
    expect([formatStars(950), formatStars(1000), formatStars(2134), formatStars(1_250_000)]).toEqual(["950", "1k", "2.1k", "1.3M"]);
  });
});

describe("githubRepoLookup", () => {
  test("anonymous by default, one GET to the repo endpoint", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const lookup = githubRepoLookup({ token: "", fetchImpl: fakeFetch({ status: 200, body: REPO_JSON }, seen), today: () => "2026-10-25" });
    expect(await lookup("https://github.com/example/harness/tree/main", new AbortController().signal)).toBe(
      "Eval-first harness for invented agents, TypeScript, MIT, ★ 2.1k on 2026-10-25",
    );
    expect(seen).toEqual([{ url: "https://api.github.com/repos/example/harness" }]);
  });

  test("a token is sent as a bearer", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const lookup = githubRepoLookup({ token: "invented-token", fetchImpl: fakeFetch({ status: 200, body: REPO_JSON }, seen) });
    await lookup("https://github.com/example/harness", new AbortController().signal);
    expect(seen[0]!.auth).toBe("Bearer invented-token");
  });

  test("a 404 or a rate limit is null, and the line stays plain", async () => {
    for (const status of [404, 403]) {
      const lookup = githubRepoLookup({ token: "", fetchImpl: fakeFetch({ status, body: { message: "Not Found" } }, []) });
      expect(await lookup("https://github.com/example/missing", new AbortController().signal)).toBeNull();
      expect(await withRepoDetails([line("https://github.com/example/missing")], lookup)).toEqual([
        line("https://github.com/example/missing"),
      ]);
    }
  });

  test("not a repo URL: no request at all", async () => {
    const seen: Array<{ url: string }> = [];
    const lookup = githubRepoLookup({ token: "", fetchImpl: fakeFetch({ status: 200, body: REPO_JSON }, seen) });
    expect(await lookup("https://example.org/x", new AbortController().signal)).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("withRepoDetails", () => {
  test("an existing detail stays in front; a non-GitHub line is untouched", async () => {
    const out = await withRepoDetails(
      [line("https://github.com/example/harness", "Example Lab"), { ...line("https://example.org/p"), icon: "📄" }],
      async () => "TypeScript, ★ 3 on 2026-10-25",
    );
    expect(out.map((l) => l.detail)).toEqual(["Example Lab, TypeScript, ★ 3 on 2026-10-25", ""]);
  });

  test("one budget for all lookups: a stalled API gives plain lines, on time", async () => {
    const started = Date.now();
    const out = await withRepoDetails(
      [line("https://github.com/example/a"), line("https://github.com/example/b")],
      () => new Promise(() => {}),
      100,
    );
    expect(Date.now() - started).toBeLessThan(800);
    expect(out.map((l) => l.detail)).toEqual(["", ""]);
  });
});
