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
  test("--pages: the page report, To-check passages, Moved with", async () => {
    const urls: string[] = [];
    const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--as-of", "2026-10-25", "--base-url", "http://m:1/"], {
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
    expect(text).not.toContain("check repos/x.md");
  });

  test("PR 2a: a confirmed hit counts, an unconfirmed one is named apart, a passage verdict is printed", async () => {
    const r2 = {
      ...report,
      staleLines: 1,
      hits: [
        { ...report.hits[0], confirmation: { verdict: "stale", reason: "the plan shipped 22.10" } },
        { line: 128, target: "plans/q.mdx", said: ["proposed"], now: "in-flight", text: "q", confirmation: "unconfirmed" },
      ],
      buckets: { ...report.buckets, linking: [{ ...report.buckets.linking[0], verdict: { verdict: "true", reason: "still so" } }, report.buckets.linking[1]] },
    };
    const text = (await runWikiStale(["--wiki", "w", "--pages", "repos/x.md"], { fetchJson: fake(() => r2) })).join("\n");
    expect(text).toContain("stale status lines: 1 (+ 1 unconfirmed hit)");
    expect(text).toContain("plan_status shipped [stale: the plan shipped 22.10]");
    expect(text).toContain("plan_status in-flight [unconfirmed]");
    expect(text).toContain("repos/api.md — API (last change 2026-10-06) [still true: still so]");
  });

  test("--check posts the check route for a changed page and prints each streamed verdict", async () => {
    const posts: { url: string; body: unknown }[] = [];
    async function* events() {
      yield { event: "start", data: { toCheck: 2, cached: 1, toCall: 1, left: 0 } };
      yield { event: "verdict", data: { relPath: "repos/old.md", verdict: "true", reason: "fine", cached: true, edit: null } };
      yield { event: "verdict", data: { relPath: "repos/api.md", verdict: "stale", reason: "misses the pin rule", cached: false, edit: { old: "a", new: "b" } } };
      yield { event: "done", data: { calls: 1, verdicts: 2, errors: 0, left: 0 } };
    }
    const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--as-of", "2026-10-25", "--check", "--base-url", "http://m:1"], {
      fetchJson: fake(() => report),
      postSse: async (url, body) => {
        posts.push({ url, body });
        return { status: 200, events: events() };
      },
    });
    expect(posts).toEqual([{ url: "http://m:1/api/wiki/stale/check", body: { wiki: "w", page: "repos/x.md", asOf: "2026-10-25" } }]);
    const text = out.join("\n");
    expect(text).toContain("2 to check: 1 cached, 1 model call(s)");
    expect(text).toContain("repos/old.md [still true: fine] (cached)");
    expect(text).toContain("repos/api.md [stale: misses the pin rule] — edit: «a» → «b»");
    expect(text).toContain("done: 1 call(s), 2 verdict(s), 0 error(s)");
  });

  test("--check skips a page that is not changed, and a refused check is one line", async () => {
    let posted = 0;
    const notChanged = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--check"], {
      fetchJson: fake(() => ({ ...report, changed: false, buckets: null })),
      postSse: async () => ((posted++), { status: 200 }),
    });
    expect(posted).toBe(0);
    expect(notChanged.join("\n")).not.toContain("check repos/x.md");
    const refused = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--check"], {
      fetchJson: fake(() => report),
      postSse: async () => ({ status: 409, body: { error: "No routing bot for this wiki" } }),
    });
    expect(refused).toContain("wiki-stale: check repos/x.md: No routing bot for this wiki");
  });

  test("--check gets the longer run deadline, a plain run keeps 25 s", async () => {
    const { CHECK_RUN_DEADLINE_MS, RUN_DEADLINE_MS } = await import("./wiki-stale.ts");
    expect(RUN_DEADLINE_MS).toBe(25_000);
    expect(CHECK_RUN_DEADLINE_MS).toBe(300_000);
    const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--check"], {
      deadlineMs: 50,
      fetchJson: fake(() => report),
      postSse: () => new Promise(() => {}),
    });
    expect(out.at(-1)).toBe("wiki-stale: check repos/x.md did not finish in 0.05 s");
  });

  test("readSse parses event blocks across chunk boundaries", async () => {
    const { readSse } = await import("./wiki-stale.ts");
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: start\ndata: {"toCheck":1}\n\nevent: ver'));
        c.enqueue(enc.encode('dict\ndata: {"relPath":"a.md"}\n\n'));
        c.close();
      },
    });
    const got: unknown[] = [];
    for await (const e of readSse(body)) got.push(e);
    expect(got).toEqual([
      { event: "start", data: { toCheck: 1 } },
      { event: "verdict", data: { relPath: "a.md" } },
    ]);
  });

  test("a readonly instance prints the free checks plus one «check unavailable» line", async () => {
    const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--check"], { fetchJson: fake(() => ({ ...report, readonly: "instance" })) });
    expect(out.filter((l) => l.startsWith("check"))).toEqual(["check unavailable: readonly instance"]);
    expect(out.join("\n")).toContain("repos/api.md");
  });

  test("a readonly wiki on a writable instance names the wiki, not the instance (B4-3)", async () => {
    const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--check"], { fetchJson: fake(() => ({ ...report, readonly: "root" })) });
    expect(out.filter((l) => l.startsWith("check"))).toEqual(["check unavailable: readonly wiki"]);
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

  test("the summary prints rows with something to check first and folds the rest into one count line (B4-3)", async () => {
    const pages = [
      { relPath: "z0.md", staleLines: 0, toCheck: 0, changed: true, dirty: false },
      { relPath: "a1.md", staleLines: 0, toCheck: 2, changed: true, dirty: false },
      { relPath: "z1.md", staleLines: 0, toCheck: 0, changed: true, dirty: false },
      { relPath: "b1.md", staleLines: 1, toCheck: 0, changed: true, dirty: false },
      { relPath: "d0.md", staleLines: 0, toCheck: 0, changed: true, dirty: true },
      { relPath: "o1.md", staleLines: 3, toCheck: 0, changed: false, dirty: false },
    ];
    const summary = { wiki: "w", asOfMs: 0, totals: { staleLines: 4, toCheck: 2, changedPages: 5 }, pages };
    const out = await runWikiStale(["--wiki", "w"], { env: {}, fetchJson: fake(() => summary) });
    const rel = (l: string) => l.trim().split(" ")[0];
    expect(out.slice(1).map((l) => (l.startsWith("  ") && !l.startsWith("  +") ? rel(l) : l))).toEqual([
      "uncommitted (1):",
      "  + 1 page with nothing stale",
      "recently committed (4):",
      "a1.md",
      "b1.md",
      "  + 2 pages with nothing stale",
      "older pages with stale status lines (1):",
      "o1.md",
    ]);
    // --json keeps every row.
    const json = await runWikiStale(["--wiki", "w", "--json"], { env: {}, fetchJson: fake(() => summary) });
    expect(JSON.parse(json[0]!).pages).toHaveLength(6);
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

describe("R2-5: a wrong answer is one line for its page, and the run goes on", () => {
  test("an HTML 200 (a wrong --base-url) is «unexpected answer (not JSON)», not «HTTP 200»", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><p>hi</p>", { headers: { "content-type": "text/html" } }) });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "--base-url", base], { env: {} });
      expect(out).toEqual([`wiki-stale: unexpected answer (not JSON) from ${base}/api/wiki/stale?wiki=w&page=a.md`]);
      const json = await runWikiStale(["--wiki", "w", "--base-url", base, "--json"], { env: {} });
      expect(json.map((l) => JSON.parse(l))).toEqual([{ notice: `wiki-stale: unexpected answer (not JSON) from ${base}/api/wiki/stale?wiki=w` }]);
    } finally {
      server.stop(true);
    }
  });

  const BAD = "is --base-url a muninn of this version?";
  test("a shallow-valid, deep-wrong page answer is one «unexpected answer» line, never a TypeError", async () => {
    const bad: Record<string, unknown>[] = [
      { ...report, hits: [{ ...report.hits[0], said: "proposed" }] },
      { ...report, hits: [null] },
      { ...report, hits: [{ ...report.hits[0], line: "124" }] },
      { ...report, page: { relPath: "repos/x.md", title: 7 } },
      { ...report, lastChangeMs: "yesterday" },
      { ...report, buckets: { ...report.buckets, counts: { toCheck: "1" } } },
      { ...report, buckets: { ...report.buckets, linking: [null] } },
      { ...report, buckets: { ...report.buckets, linking: [{ ...report.buckets.linking[0], passages: [null] }] } },
      { ...report, buckets: { ...report.buckets, linking: [{ ...report.buckets.linking[0], passages: "none" }] } },
      { ...report, buckets: { ...report.buckets, linking: [{ ...report.buckets.linking[0], lastChangeMs: Number.MAX_VALUE }] } },
      { ...report, movedWith: [null] },
      { ...report, movedWith: "none" },
    ];
    for (const [i, body] of bad.entries()) {
      const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md"], { env: {}, fetchJson: async () => ({ status: 200, body }) });
      expect([i, out]).toEqual([i, [`wiki-stale: unexpected answer from http://127.0.0.1:3010 for page repos/x.md — ${BAD}`]]);
    }
  });

  test("a shallow-valid, deep-wrong summary or session answer is one «unexpected answer» line", async () => {
    const summary = { wiki: "w", asOfMs: 0, totals: { staleLines: 0, toCheck: 0, changedPages: 1 }, pages: [{ relPath: "a.md", staleLines: 0, toCheck: 0, changed: true, dirty: false }] };
    for (const body of [{ ...summary, pages: [null] }, { ...summary, totals: { staleLines: "0" } }, { ...summary, pages: [{ relPath: "a.md" }] }, { ...summary, asOfMs: "now" }]) {
      const out = await runWikiStale(["--wiki", "w"], { env: {}, fetchJson: async () => ({ status: 200, body }) });
      expect([body, out]).toEqual([body, [`wiki-stale: unexpected answer from http://127.0.0.1:3010 for the summary — ${BAD}`]]);
    }
    const session = { session: { id: "s", found: true, asOfMs: "now", pages: [] } };
    const out = await runWikiStale(["--wiki", "w", "--session", "s"], { env: {}, fetchJson: async () => ({ status: 200, body: session }) });
    expect(out).toEqual([`wiki-stale: unexpected answer from http://127.0.0.1:3010 for session s — ${BAD}`]);
  });

  test("with --pages a b c, a bad answer for a still asks b and c; --json lines all parse", async () => {
    for (const json of [false, true]) {
      const urls: string[] = [];
      const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "b.md", "c.md", ...(json ? ["--json"] : [])], {
        env: {},
        fetchJson: fake((q) => (q.get("page") === "a.md" ? { ...report, hits: [{ ...report.hits[0], said: "x" }] } : { ...report, page: { relPath: q.get("page"), title: "T" } }), urls),
      });
      expect(urls).toHaveLength(3);
      if (json) {
        for (const l of out) expect(() => JSON.parse(l)).not.toThrow();
        expect(out.map((l) => JSON.parse(l)).filter((o) => o.page).map((o) => o.page.relPath)).toEqual(["repos/x.md", "b.md", "c.md"]);
      } else {
        expect(out[0]).toBe(`wiki-stale: unexpected answer from http://127.0.0.1:3010 for page a.md — ${BAD}`);
        expect(out).toContain("b.md — T");
        expect(out).toContain("c.md — T");
      }
    }
  });

  test("a throw the guards miss ends only that page's report", async () => {
    const urls: string[] = [];
    const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "b.md"], {
      env: {},
      fetchJson: fake((q) => {
        const body: Record<string, unknown> = { ...report, page: { relPath: q.get("page"), title: "T" } };
        if (q.get("page") === "a.md") {
          // Throws only when the printer reads it, after the guard passed.
          Object.defineProperty(body, "movedWith", { enumerable: true, get: () => { if (new Error().stack?.includes("formatPageReport")) throw new TypeError("late"); return []; } });
        }
        return body;
      }, urls),
    });
    expect(urls).toHaveLength(2);
    expect(out[0]).toBe("wiki-stale: unexpected answer from http://127.0.0.1:3010 for page a.md: late");
    expect(out).toContain("b.md — T");
  });
});

test("the script exits 0, even on a usage error", async () => {
  const proc = Bun.spawn(["bun", "--no-env-file", `${import.meta.dir}/wiki-stale.ts`, "--bogus"], { stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(code).toBe(0);
  expect(out).toContain("unknown argument --bogus");
});
