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
    expect(urls).toEqual(["http://m:1/api/wiki/stale?wiki=w&asOf=2026-10-25&page=repos%2Fx.md&refresh=1"]);
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

  test("each Check gets its own 5-minute bound, the free reports keep 25 s", async () => {
    const { CHECK_PAGE_DEADLINE_MS, RUN_DEADLINE_MS } = await import("./wiki-stale.ts");
    expect(RUN_DEADLINE_MS).toBe(25_000);
    expect(CHECK_PAGE_DEADLINE_MS).toBe(300_000);
    const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md", "--check"], {
      checkDeadlineMs: 50,
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
    expect(urls.map((u) => new URL(u).searchParams.toString())).toEqual(["wiki=w&session=claude-code%3Aabc&refresh=1", "wiki=w&page=repos%2Fx.md"]);
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
      expect(out).toEqual([`wiki-stale: unexpected answer (not JSON) from ${base}/api/wiki/stale?wiki=w&page=a.md&refresh=1`]);
      const json = await runWikiStale(["--wiki", "w", "--base-url", base, "--json"], { env: {} });
      expect(json.map((l) => JSON.parse(l))).toEqual([{ notice: `wiki-stale: unexpected answer (not JSON) from ${base}/api/wiki/stale?wiki=w&refresh=1` }]);
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

describe("A10: --check streams, a slow page never starves the next, and an unavailable store is said", () => {
  const verdictEvents = (relPath: string) =>
    (async function* () {
      yield { event: "start", data: { toCheck: 1, cached: 0, toCall: 1, left: 0 } };
      yield { event: "verdict", data: { relPath, verdict: "stale", reason: "moved", cached: false, edit: null } };
      yield { event: "done", data: { calls: 1, verdicts: 1, errors: 0, left: 0 } };
    })();
  const pageReport = (relPath: string) => ({ ...report, page: { relPath, title: relPath } });

  test("a Check that hangs on page a ends at its own deadline, and page b is still checked", async () => {
    const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "b.md", "--check"], {
      deadlineMs: 2_000,
      checkDeadlineMs: 100,
      fetchJson: fake((q) => pageReport(q.get("page")!)),
      postSse: async (_url, body) => (body.page === "a.md" ? new Promise(() => {}) : { status: 200, events: verdictEvents("linker-of-b.md") }),
    });
    expect(out).toContain("wiki-stale: check a.md did not finish in 0.1 s");
    expect(out.join("\n")).toContain("linker-of-b.md [stale: moved]");
  });

  test("the free reports keep their own budget: a Check's time is not charged to it, nor bounded by it", async () => {
    const t0 = Date.now();
    const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "b.md", "--check"], {
      deadlineMs: 200,
      checkDeadlineMs: 5_000,
      fetchJson: (url) => (new URL(url).searchParams.get("page") === "b.md" ? new Promise(() => {}) : Promise.resolve({ status: 200, body: pageReport("a.md") })),
      postSse: async () => {
        await Bun.sleep(300);
        return { status: 200, events: verdictEvents("linker-of-a.md") };
      },
    });
    expect(out.join("\n")).toContain("linker-of-a.md [stale: moved]");
    expect(out).toContain("wiki-stale: muninn did not answer in 0.2 s — no stale report");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("--check --json: every line parses, each streamed event one line", async () => {
    const lines: string[] = [];
    await runWikiStale(["--wiki", "w", "--pages", "a.md", "--check", "--json"], {
      fetchJson: fake(() => pageReport("a.md")),
      postSse: async () => ({ status: 200, events: verdictEvents("linker-of-a.md") }),
      write: (l) => lines.push(l),
    });
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(lines.map((l) => JSON.parse(l).event).filter(Boolean)).toEqual(["start", "verdict", "done"]);
  });

  test("the free budget is shared: slow GETs on several pages spend one 25 s budget between them", async () => {
    const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "b.md", "c.md"], {
      deadlineMs: 200,
      fetchJson: async (url) => {
        await Bun.sleep(120);
        return { status: 200, body: pageReport(new URL(url).searchParams.get("page")!) };
      },
    });
    expect(out).toContain("a.md — a.md");
    expect(out).toContain("wiki-stale: muninn did not answer in 0.2 s — no stale report");
    expect(out.join("\n")).not.toContain("b.md — b.md");
    expect(out.join("\n")).not.toContain("c.md — c.md");
  });

  test("verdicts: unavailable says the verdict store is unavailable, not zero stale lines", async () => {
    const out = await runWikiStale(["--wiki", "w", "--pages", "repos/x.md"], {
      fetchJson: fake(() => ({ ...report, staleLines: 0, hits: report.hits.map((h) => ({ ...h, confirmation: "unconfirmed" })), verdicts: "unavailable" })),
    });
    const text = out.join("\n");
    expect(text).not.toContain("stale status lines: 0");
    expect(text).toContain("stale status lines: unknown — the verdict store is unavailable");
    const summary = await runWikiStale(["--wiki", "w"], {
      fetchJson: fake(() => ({ wiki: "w", verdicts: "unavailable", totals: { staleLines: 0, toCheck: 1, changedPages: 1, hits: 2 }, pages: [] })),
    });
    expect(summary.join("\n")).toContain("the verdict store is unavailable");
    expect(summary.join("\n")).not.toContain("w: 0 stale status line(s)");
  });

  test("the script prints each verdict as its event arrives, not at exit", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let released = false;
    const enc = new TextEncoder();
    const frame = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const server = Bun.serve({
      port: 0,
      idleTimeout: 30,
      fetch(req) {
        if (req.method === "GET") return Response.json(report);
        return new Response(
          new ReadableStream({
            async start(ctrl) {
              ctrl.enqueue(frame("start", { toCheck: 2, cached: 0, toCall: 2, left: 0 }));
              ctrl.enqueue(frame("verdict", { relPath: "repos/api.md", verdict: "stale", reason: "early", cached: false, edit: null }));
              await held;
              ctrl.enqueue(frame("done", { calls: 2, verdicts: 1, errors: 0, left: 0 }));
              ctrl.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const timer = setTimeout(() => ((released = true), release()), 4_000);
    try {
      const proc = Bun.spawn(["bun", "--no-env-file", `${import.meta.dir}/wiki-stale.ts`, "--wiki", "w", "--pages", "repos/x.md", "--check", "--base-url", `http://127.0.0.1:${server.port}`], { stdout: "pipe", stderr: "pipe" });
      const dec = new TextDecoder();
      let seen = "";
      let earlyBeforeRelease = false;
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        seen += dec.decode(chunk, { stream: true });
        if (seen.includes("repos/api.md [stale: early]") && !released) {
          earlyBeforeRelease = true;
          released = true;
          release();
        }
      }
      expect(await proc.exited).toBe(0);
      expect(earlyBeforeRelease).toBe(true);
      expect(seen).toContain("done: 2 call(s), 1 verdict(s), 0 error(s)");
    } finally {
      clearTimeout(timer);
      release();
      server.stop(true);
    }
  }, 15_000);
});

test("the script exits 0, even on a usage error", async () => {
  const proc = Bun.spawn(["bun", "--no-env-file", `${import.meta.dir}/wiki-stale.ts`, "--bogus"], { stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(code).toBe(0);
  expect(out).toContain("unknown argument --bogus");
});

describe("a fresh index: the run's first answered report asks muninn to rebuild it", () => {
  test("only the first GET carries refresh=1 once it is answered; after a failed one the next asks again", async () => {
    const urls: string[] = [];
    await runWikiStale(["--wiki", "w", "--pages", "a.md", "b.md", "c.md"], { env: {}, fetchJson: fake(() => report, urls) });
    expect(urls.map((u) => new URL(u).searchParams.get("refresh"))).toEqual(["1", null, null]);
    const tried: string[] = [];
    await runWikiStale(["--wiki", "w", "--pages", "a.md", "b.md", "c.md"], {
      env: {},
      fetchJson: async (url) => {
        tried.push(url);
        return new URL(url).searchParams.get("page") === "a.md" ? { status: 503, body: { error: "wiki directory not found" } } : { status: 200, body: report };
      },
    });
    expect(tried.map((u) => new URL(u).searchParams.get("refresh"))).toEqual(["1", "1", null]);
  });
});

describe("--send: drafted edits for other pages go to the Gardener, the run's own pages never do (D12)", () => {
  const TRICKY = `it's "quoted", \`ticked\`, $HOME and $(rm -rf x) — ünïcødé ✓ 23.05`;
  type Verdict = { relPath: string; verdict: string; reason?: string; edit: { old: string; new: string } | null };
  /** A stub muninn on a real port: the page report, Check's SSE stream and the send route, recording each send. */
  function stub(opts: { verdicts: Record<string, Verdict[]>; send?: (body: Record<string, any>) => Response; readonly?: string | false; resolve?: (ref: string) => string }) {
    const sends: { raw: string; body: Record<string, any>; contentType: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (req.method === "GET" && u.pathname === "/api/wiki/stale") {
          const rel = (opts.resolve ?? ((r: string) => r))(u.searchParams.get("page") ?? "");
          return Response.json({ ...report, readonly: opts.readonly ?? false, page: { relPath: rel, title: rel } });
        }
        if (req.method === "POST" && u.pathname === "/api/wiki/stale/check") {
          const { page } = (await req.json()) as { page: string };
          const vs = opts.verdicts[page] ?? [];
          const frames = [
            ["start", { type: "start", changed: page, toCheck: vs.length, cached: 0, toCall: vs.length, left: 0 }],
            ...vs.map((v) => ["verdict", { type: "verdict", reason: "r", cached: false, ...v }]),
            ["done", { type: "done", calls: vs.length, joined: 0, verdicts: vs.length, errors: 0, left: 0 }],
          ];
          return new Response(frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
        }
        if (req.method === "POST" && u.pathname === "/api/wiki/stale/send") {
          const raw = await req.text();
          const body = JSON.parse(raw) as Record<string, any>;
          sends.push({ raw, body, contentType: req.headers.get("content-type") });
          return opts.send ? opts.send(body) : Response.json({ ok: true, outcome: "sent", groupKey: `stale-check:${body.page}:1`, supersedes: null, pages: [body.linking], fixes: 1, dropped: [] });
        }
        return new Response("404 Not Found", { status: 404 });
      },
    });
    return { sends, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }
  const edit = (old: string) => ({ old, new: "x" });

  test("own pages (by path without extension, and by the relPath the route resolved) are «yours»; others are sent with old exactly as drafted", async () => {
    const s = stub({
      resolve: (ref) => (ref === "Own Title" ? "notes/titled.md" : ref),
      verdicts: {
        "a.md": [
          { relPath: "notes/own.md", verdict: "stale", edit: edit("own text") },
          { relPath: "notes/titled.md", verdict: "stale", edit: edit("titled text") },
          { relPath: "notes/other.md", verdict: "stale", edit: edit(TRICKY) },
          { relPath: "notes/noedit.md", verdict: "stale", edit: null },
          { relPath: "notes/fine.md", verdict: "true", edit: null },
        ],
      },
    });
    try {
      // `Own Title` is reported after a.md's Check: the sends wait for its relPath.
      const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "notes/own", "Own Title", "--check", "--send", "--base-url", s.base], { env: {} });
      expect(s.sends).toHaveLength(1);
      expect(s.sends[0]!.contentType).toBe("application/json");
      expect(s.sends[0]!.body).toEqual({ wiki: "w", page: "a.md", kind: "passage", linking: "notes/other.md", variant: "new", old: TRICKY });
      expect(JSON.parse(s.sends[0]!.raw).old).toBe(TRICKY);
      const sendLines = out.slice(out.indexOf("send to the Gardener:") + 1);
      expect(sendLines).toEqual([
        "  notes/own.md (after a.md): yours — fix it by hand",
        "  notes/titled.md (after a.md): yours — fix it by hand",
        "  notes/other.md (after a.md): sent — group stale-check:a.md:1, card pages notes/other.md",
        "  notes/noedit.md (after a.md): stale, no drafted edit — fix by hand",
      ]);
    } finally {
      s.stop();
    }
  });

  // Fix round 2 batch 5, finding 2: `--pages foo` resolved to plans/foo.md
  // owns that page only; archive/foo.md shares the stem and is sent.
  test("a bare stem the route resolved owns its resolved page, not a same-stem page in another folder", async () => {
    const s = stub({
      resolve: (ref) => (ref === "foo" ? "plans/foo.md" : ref),
      verdicts: {
        "plans/foo.md": [
          { relPath: "plans/foo.md", verdict: "stale", edit: edit("self") },
          { relPath: "archive/foo.md", verdict: "stale", edit: edit("archived") },
        ],
      },
    });
    try {
      const out = await runWikiStale(["--wiki", "w", "--pages", "foo", "--check", "--send", "--base-url", s.base], { env: {} });
      expect(s.sends.map((x) => x.body.linking)).toEqual(["archive/foo.md"]);
      expect(out.slice(out.indexOf("send to the Gardener:") + 1)).toEqual([
        "  plans/foo.md (after plans/foo.md): yours — fix it by hand",
        "  archive/foo.md (after plans/foo.md): sent — group stale-check:plans/foo.md:1, card pages archive/foo.md",
      ]);
    } finally {
      s.stop();
    }
  });

  // Fix round 2 batch 4, finding 3: the send carries the run's day, so the
  // route reads the buckets of that window, and `old` with its whitespace.
  test("--as-of rides every send, and old is sent with its whitespace", async () => {
    const s = stub({ verdicts: { "a.md": [{ relPath: "notes/other.md", verdict: "stale", edit: edit("  padded old \n") }] } });
    try {
      await runWikiStale(["--wiki", "w", "--pages", "a.md", "--as-of", "2026-10-25", "--check", "--send", "--base-url", s.base], { env: {} });
      expect(s.sends.map((x) => x.body)).toEqual([{ wiki: "w", page: "a.md", kind: "passage", linking: "notes/other.md", variant: "new", old: "  padded old \n", asOf: "2026-10-25" }]);
    } finally {
      s.stop();
    }
  });

  test("a JSON refusal is one line with its status and error, and the next page is still sent", async () => {
    const held = "notes/held.md is held by another Gardener card (Lint, lint:1): accept or dismiss it first.";
    const s = stub({
      verdicts: { "a.md": [{ relPath: "notes/held.md", verdict: "stale", edit: edit("h") }, { relPath: "notes/other.md", verdict: "stale", edit: edit("o") }] },
      send: (b) => (b.linking === "notes/held.md" ? Response.json({ error: held }, { status: 409 }) : Response.json({ ok: true, outcome: "sent", groupKey: "g:2", supersedes: "g:1", pages: ["notes/held.md", "notes/other.md"], fixes: 2, dropped: [] })),
    });
    try {
      const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "--check", "--send", "--base-url", s.base], { env: {} });
      expect(s.sends.map((x) => x.body.linking)).toEqual(["notes/held.md", "notes/other.md"]);
      expect(out).toContain(`  notes/held.md (after a.md): refused — HTTP 409: ${held}`);
      expect(out).toContain("  notes/other.md (after a.md): sent — group g:2, card pages notes/held.md, notes/other.md (replaces g:1)");
    } finally {
      s.stop();
    }
  });

  test("a muninn without the send route (a non-JSON 404) is said once, and nothing more is sent", async () => {
    const s = stub({
      verdicts: { "a.md": [{ relPath: "notes/b.md", verdict: "stale", edit: edit("b") }, { relPath: "notes/c.md", verdict: "stale", edit: edit("c") }] },
      send: () => new Response("404 Not Found", { status: 404 }),
    });
    try {
      const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "--check", "--send", "--base-url", s.base], { env: {} });
      expect(s.sends).toHaveLength(1);
      expect(out.filter((l) => l.includes("no send route"))).toEqual([`wiki-stale: ${s.base} has no send route (POST /api/wiki/stale/send) — nothing was sent to the Gardener`]);
      expect(out.join("\n")).not.toContain("notes/c.md (after");
    } finally {
      s.stop();
    }
  });

  test("readonly: no Check and no send, one notice each; a readonly refusal from the send route stops the rest", async () => {
    const ro = stub({ readonly: "instance", verdicts: { "a.md": [{ relPath: "notes/b.md", verdict: "stale", edit: edit("b") }] } });
    try {
      const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "--check", "--send", "--base-url", ro.base], { env: {} });
      expect(ro.sends).toHaveLength(0);
      expect(out.slice(-2)).toEqual(["check unavailable: readonly instance", "send unavailable: readonly instance — nothing was sent to the Gardener"]);
    } finally {
      ro.stop();
    }
    const refuses = stub({
      verdicts: { "a.md": [{ relPath: "notes/b.md", verdict: "stale", edit: edit("b") }, { relPath: "notes/c.md", verdict: "stale", edit: edit("c") }] },
      send: () => Response.json({ error: "this wiki is registered read-only (WIKI_READONLY_ROOTS) — muninn only reads it", readonly: true }, { status: 403 }),
    });
    try {
      const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "--check", "--send", "--base-url", refuses.base], { env: {} });
      expect(refuses.sends).toHaveLength(1);
      expect(out.some((l) => l.startsWith("  notes/b.md (after a.md): refused — HTTP 403: this wiki is registered read-only"))).toBe(true);
      expect(out.slice(-2)).toEqual(["check unavailable: readonly wiki", "send unavailable: readonly wiki — nothing was sent to the Gardener"]);
    } finally {
      refuses.stop();
    }
  });

  test("--json: one send event per outcome, every line parses", async () => {
    const s = stub({
      verdicts: { "a.md": [{ relPath: "a2.md", verdict: "stale", edit: edit("own") }, { relPath: "notes/b.md", verdict: "stale", edit: edit(TRICKY) }, { relPath: "notes/c.md", verdict: "stale", edit: null }] },
    });
    try {
      const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "a2", "--check", "--send", "--json", "--base-url", s.base], { env: {} });
      const parsed = out.map((l) => JSON.parse(l));
      expect(parsed.filter((o) => o.event === "send").map((o) => [o.linking, o.outcome])).toEqual([
        ["a2.md", "own"],
        ["notes/b.md", "sent"],
        ["notes/c.md", "no-edit"],
      ]);
      expect(s.sends.map((x) => x.body.old)).toEqual([TRICKY]);
    } finally {
      s.stop();
    }
  });

  test("--send without --check sends nothing and says so; the sends have their own bound", async () => {
    const s = stub({ verdicts: { "a.md": [{ relPath: "notes/b.md", verdict: "stale", edit: edit("b") }] } });
    try {
      const out = await runWikiStale(["--wiki", "w", "--pages", "a.md", "--send", "--base-url", s.base], { env: {} });
      expect(out[0]).toBe("send: --send works only with --check; nothing is sent");
      expect(s.sends).toHaveLength(0);
      const hung = await runWikiStale(["--wiki", "w", "--pages", "a.md", "--check", "--send", "--base-url", s.base], { env: {}, sendDeadlineMs: 50, postJson: () => new Promise(() => {}) });
      expect(hung).toContain("wiki-stale: the sends did not finish in 0.05 s — the rest were not sent");
    } finally {
      s.stop();
    }
  });
});

describe("isOwnPage", () => {
  test("matches the route's resolved relPath, a path with or without its extension, and a bare stem", async () => {
    const { isOwnPage } = await import("./wiki-stale.ts");
    expect(isOwnPage("notes/A.md", new Set(["notes/a.md"]), [])).toBe(true);
    expect(isOwnPage("notes/a.mdx", new Set(), ["./notes/a"])).toBe(true);
    expect(isOwnPage("notes/a.md", new Set(), ["/notes/a.md"])).toBe(true);
    expect(isOwnPage("notes/a.md", new Set(), ["a"])).toBe(true);
    expect(isOwnPage("notes/a.md", new Set(), ["notes/a.mdx"])).toBe(false);
    expect(isOwnPage("notes/ab.md", new Set(["notes/a.md"]), ["notes/a", "a"])).toBe(false);
  });
});
