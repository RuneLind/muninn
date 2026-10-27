import { test, expect, describe } from "bun:test";
import { parseStaleArgs, runWikiStale, type FetchJson } from "./wiki-stale.ts";

const report = {
  wiki: "w",
  readonly: false,
  asOfMs: Date.parse("2026-10-25T23:59:59.999Z"),
  page: { relPath: "repos/x.md", title: "X" },
  changed: true,
  dirty: false,
  lastChangeMs: Date.parse("2026-10-23T10:00:00Z"),
  hits: [{ line: 124, target: "plans/p.mdx", said: ["proposed"], now: "shipped", text: "- [[plans/p]] — forslag 22.10" }],
  buckets: {
    counts: { toCheck: 1, mentions: 0, pointers: 0, history: 1, changedSince: 0 },
    linking: [
      { relPath: "repos/api.md", title: "API", bucket: "toCheck", lastChangeMs: Date.parse("2026-10-06T00:00:00Z"), passages: [{ line: 59, text: "pin rule from [[repos/x]] on 12.10", claim: "date" }] },
      { relPath: "archive/a.md", title: "A", bucket: "history", passages: [] },
    ],
  },
  movedWith: [{ relPath: "plans/p.mdx", n: 2 }],
};

/** A fake muninn: records every URL, answers by query. */
function fake(answer: (q: URLSearchParams) => Record<string, unknown>, urls: string[] = []): FetchJson {
  return async (url) => {
    urls.push(url);
    return { status: 200, body: answer(new URL(url).searchParams) };
  };
}

describe("parseStaleArgs", () => {
  test("several pages, space- or comma-separated, and the flags", () => {
    const { args, errors } = parseStaleArgs(["--wiki", "w", "--pages", "a.md", "b.md,c.md", "--as-of", "2026-10-25", "--check"]);
    expect(errors).toEqual([]);
    expect(args).toMatchObject({ wiki: "w", pages: ["a.md", "b.md", "c.md"], asOf: "2026-10-25", check: true });
  });

  test("a flag missing its value does not swallow the next flag", () => {
    const { args, errors } = parseStaleArgs(["--wiki", "--check"]);
    expect(errors).toEqual(["--wiki needs a value"]);
    expect(args.check).toBe(true);
  });
});

describe("runWikiStale", () => {
  test("--pages: the page report, To-check passages, Moved with, and the PR 2a line for --check", async () => {
    const urls: string[] = [];
    const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--as-of", "2026-10-25", "--check", "--base-url", "http://m:1/"], {
      fetchJson: fake(() => report, urls),
    });
    expect(urls).toEqual(["http://m:1/api/wiki/stale?wiki=w&asOf=2026-10-25&page=repos%2Fx.md"]);
    const text = out.join("\n");
    expect(text).toContain("stale status lines: 1");
    expect(text).toContain("L124  «proposed» after [[plans/p.mdx]] — plan_status shipped");
    expect(text).toContain("linking pages: 2 — to check 1 · mentions 0 · pointers 0 · history 1 · changed since 0");
    expect(text).toContain("repos/api.md — API (last change 2026-10-06)");
    expect(text).toContain("L59 [date] pin rule");
    expect(text).toContain("moved with: plans/p.mdx ×2");
    expect(out.at(-1)).toBe("check: the model checks arrive with PR 2a — these are the free checks only");
  });

  test("a readonly instance prints the free checks plus one «check unavailable» line", async () => {
    const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--check"], { fetchJson: fake(() => ({ ...report, readonly: true })) });
    expect(out.filter((l) => l.startsWith("check"))).toEqual(["check unavailable: readonly instance"]);
    expect(out.join("\n")).toContain("repos/api.md");
  });

  test("neither --pages nor --session: the summary, grouped uncommitted / recently committed", async () => {
    const out = await runWikiStale(["--wiki", "w"], {
      env: {},
      fetchJson: fake((q) => {
        expect(q.has("page")).toBe(false);
        return {
          wiki: "w",
          asOfMs: Date.parse("2026-10-25T00:00:00Z"),
          totals: { staleLines: 2, toCheck: 3, changedPages: 2 },
          pages: [
            { relPath: "a.md", staleLines: 2, toCheck: 1, changed: true, dirty: true, lastChangeMs: 0 },
            { relPath: "b.md", staleLines: 0, toCheck: 2, changed: true, dirty: false },
          ],
        };
      }),
    });
    expect(out[0]).toBe("w: 2 stale status line(s), 3 linking page(s) to check, 2 changed page(s) in the 14 days to 2026-10-25");
    expect(out).toContain("uncommitted (1):");
    expect(out).toContain("recently committed (1):");
  });

  test("--session: the pages the session wrote, each reported", async () => {
    const urls: string[] = [];
    const out = await runWikiStale(["--wiki", "w", "--session", "claude-code:abc"], {
      fetchJson: fake((q) => (q.has("session") ? { session: { id: "claude-code:abc", found: true, pages: ["repos/x.md"] } } : report), urls),
    });
    expect(urls.map((u) => new URL(u).searchParams.toString())).toEqual(["wiki=w&session=claude-code%3Aabc", "wiki=w&page=repos%2Fx.md"]);
    expect(out[0]).toBe("session claude-code:abc: 1 page(s) in w");
  });

  test("an unreachable muninn and a usage error are lines, never a throw", async () => {
    const out = await runWikiStale(["--wiki", "w", "--pages", "a.md"], {
      fetchJson: async () => {
        throw new Error("connection refused");
      },
    });
    expect(out[0]).toContain("cannot reach muninn at http://127.0.0.1:3010: connection refused");
    expect((await runWikiStale([]))[0]).toBe("wiki-stale: --wiki is required");
  });
});

describe("D13: it never fails and never holds a handoff", () => {
  test("a 200 with an unexpected shape is a line, never a throw — summary, page and session", async () => {
    const empty = fake(() => ({}));
    for (const argv of [["--wiki", "w"], ["--wiki", "w", "--pages", "a.md"], ["--wiki", "w", "--session", "claude-code:abc"]]) {
      const out = await runWikiStale(argv, { fetchJson: empty, env: {} });
      expect(out.join("\n")).toContain("unexpected answer");
    }
  });

  test("one overall deadline: a muninn that never answers costs the deadline once, not a timeout per call", async () => {
    let calls = 0;
    const never: FetchJson = () => {
      calls++;
      return new Promise(() => {});
    };
    const t0 = Date.now();
    const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "b.md", "c.md"], { fetchJson: never, env: {}, deadlineMs: 150 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(calls).toBe(1);
    expect(out).toContain("wiki-stale: muninn did not answer in 0.15 s — no stale report");
  });

  test("--json: every line parses as JSON — notices, errors and the readonly line included", async () => {
    const answers = fake((q) =>
      q.has("session")
        ? { readonly: true, session: { id: "claude-code:abc", found: true, asOfMs: 1, truncated: true, pages: ["repos/x.md", "nope.md"] } }
        : q.get("page") === "nope.md"
          ? { error: "no page nope.md" }
          : { ...report, readonly: true },
    );
    const out = await runWikiStale(["--wiki", "w", "--session", "claude-code:abc", "--check", "--json"], { fetchJson: answers, env: {} });
    expect(out.length).toBeGreaterThan(3);
    for (const line of out) expect(() => JSON.parse(line)).not.toThrow();
    const notices = out.map((l) => JSON.parse(l)).filter((o) => typeof o.notice === "string").map((o) => o.notice);
    expect(notices).toContain("check unavailable: readonly instance");
    expect(notices.some((n: string) => n.includes("no page nope.md"))).toBe(true);
  });

  test("--session prints the memo's as-of and its clipping", async () => {
    const out = await runWikiStale(["--wiki", "w", "--session", "claude-code:abc"], {
      env: {},
      fetchJson: fake((q) =>
        q.has("session")
          ? { session: { id: "claude-code:abc", found: true, asOfMs: Date.parse("2026-10-25T10:30:00Z"), truncated: true, filesCapped: true, pages: [] } }
          : report,
      ),
    });
    const text = out.join("\n");
    expect(text).toContain("work memo as of 2026-10-25 10:30Z");
    expect(text).toContain("200-session cap");
    expect(text).toContain("200-file cap");
  });
});

test("the script exits 0, even on a usage error", async () => {
  const proc = Bun.spawn(["bun", "--no-env-file", `${import.meta.dir}/wiki-stale.ts`, "--bogus"], { stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(code).toBe(0);
  expect(out).toContain("unknown argument --bogus");
});
