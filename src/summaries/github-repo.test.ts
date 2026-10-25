import { describe, expect, test } from "bun:test";
import { formatStars, githubRepoLookup, githubRepoOf, repoDetail, withRepoDetails } from "./github-repo.ts";
import type { LinkLine } from "./links-section.ts";
import { isRepoUrl } from "../youtube/description-links.ts";

/** An invented repo answer in the shape of `GET /repos/<owner>/<repo>`. */
const REPO_JSON = {
  full_name: "example/harness",
  description: "Eval-first harness for invented agents",
  language: "TypeScript",
  license: { key: "mit", name: "MIT License", spdx_id: "MIT" },
  stargazers_count: 2134,
  default_branch: "main",
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
    expect(out.map((l) => l.detail)).toEqual(["Example Lab – TypeScript, ★ 3 on 2026-10-25", ""]);
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

describe("star rounding at the unit boundary", () => {
  test("a count that rounds up to 1000 of a unit moves to the next unit", () => {
    expect([formatStars(999_949), formatStars(999_950), formatStars(999_949_999), formatStars(999_950_000)]).toEqual([
      "999.9k",
      "1M",
      "999.9M",
      "1B",
    ]);
  });
});

describe("one rule for a GitHub repo", () => {
  test("isRepoUrl and githubRepoOf agree on every github.com shape", () => {
    const urls = [
      "https://github.com/example/harness",
      "https://github.com/example/harness/pull/3",
      "https://github.com/sponsors/example",
      "https://github.com/orgs/example/people",
      "https://github.com/example",
      "https://github.com/exa%20mple/harness",
      "https://github.com/example/..x",
      "https://github.com/topics/agents",
    ];
    for (const u of urls) expect([u, isRepoUrl(new URL(u))]).toEqual([u, githubRepoOf(u) !== null]);
    expect(githubRepoOf("https://github.com/sponsors/example")).toBeNull();
  });
});

describe("repo lines: root only, deduped, bounded", () => {
  const JSON_MAIN = { ...REPO_JSON, default_branch: "main" };

  test("only the repo root or its default-branch tree gets the repo line; deeper pages stay as they are", async () => {
    const seen: Array<{ url: string }> = [];
    const lookup = githubRepoLookup({ token: "", fetchImpl: fakeFetch({ status: 200, body: JSON_MAIN }, seen), today: () => "2026-10-25" });
    const page = (url: string): LinkLine => ({ icon: "📄", title: "page", url, detail: "", provenance: "from text" });
    const deeper = [
      page("https://github.com/example/a/pull/3"),
      page("https://github.com/example/b/issues/12"),
      page("https://github.com/example/c/blob/main/README.md"),
      page("https://github.com/example/d/tree/main/subdir"),
    ];
    expect(await withRepoDetails(deeper, lookup)).toEqual(deeper);
    expect(seen).toEqual([]);
    const out = await withRepoDetails(
      [page("https://github.com/example/e/tree/main"), page("https://github.com/example/f/tree/dev")],
      lookup,
    );
    expect(out.map((l) => [l.icon, l.detail])).toEqual([
      ["📦", "Eval-first harness for invented agents, TypeScript, MIT, ★ 2.1k on 2026-10-25"],
      ["📄", ""],
    ]);
  });

  test("one lookup per repo, whatever the case", async () => {
    const calls: string[] = [];
    const out = await withRepoDetails(
      [
        line("https://github.com/example/harness"),
        line("https://github.com/Example/Harness"),
        line("https://github.com/example/harness/blob/main/x.md"),
      ],
      async (url) => {
        calls.push(url);
        return "Go, ★ 3 on 2026-10-25";
      },
    );
    expect(calls).toHaveLength(1);
    expect(out.map((l) => l.detail)).toEqual(["Go, ★ 3 on 2026-10-25", "Go, ★ 3 on 2026-10-25", ""]);
  });

  test("at most 4 lookups at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const lines = Array.from({ length: 12 }, (_, i) => line(`https://github.com/example/r${i}`));
    await withRepoDetails(lines, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight--;
      return "Go";
    });
    expect(peak).toBe(4);
  });

  test("after a rate-limit answer the remaining lookups are skipped", async () => {
    const answers: Array<{ status: number; headers?: Record<string, string> }> = [
      { status: 429 },
      { status: 403, headers: { "x-ratelimit-remaining": "0" } },
    ];
    for (const answer of answers) {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        await Bun.sleep(5);
        return new Response("{}", { status: answer.status, headers: { "content-type": "application/json", ...answer.headers } });
      }) as unknown as typeof fetch;
      const lines = Array.from({ length: 12 }, (_, i) => line(`https://github.com/example/r${i}`));
      const out = await withRepoDetails(lines, githubRepoLookup({ token: "", fetchImpl }));
      expect(calls).toBe(4);
      expect(out).toEqual(lines);
    }
  });

  test("a rate-limit answer also stops the lookups running beside it from taking more", async () => {
    let calls = 0;
    const fetchImpl = (async (input: string) => {
      calls++;
      if (String(input).endsWith("/r0")) return new Response("{}", { status: 429 });
      await Bun.sleep(20);
      return new Response(JSON.stringify(REPO_JSON), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const lines = Array.from({ length: 12 }, (_, i) => line(`https://github.com/example/r${i}`));
    const out = await withRepoDetails(lines, githubRepoLookup({ token: "", fetchImpl, today: () => "2026-10-25" }));
    expect(calls).toBe(4);
    // The three already in flight keep their answers; nothing after them is looked up.
    expect(out.filter((l) => l.detail !== "").map((l) => l.url)).toEqual([
      "https://github.com/example/r1",
      "https://github.com/example/r2",
      "https://github.com/example/r3",
    ]);
  });

  test("a 403 that is not a rate limit does not stop the others", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("{}", { status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "55" } });
    }) as unknown as typeof fetch;
    const lines = Array.from({ length: 6 }, (_, i) => line(`https://github.com/example/r${i}`));
    await withRepoDetails(lines, githubRepoLookup({ token: "", fetchImpl }));
    expect(calls).toBe(6);
  });

  test("a line with an attribution keeps it apart from the repo detail with an en dash", async () => {
    const out = await withRepoDetails([line("https://github.com/example/harness", "Example Lab, Invented Person")], async () =>
      "TypeScript, ★ 3 on 2026-10-25",
    );
    expect(out[0]!.detail).toBe("Example Lab, Invented Person – TypeScript, ★ 3 on 2026-10-25");
  });
});
