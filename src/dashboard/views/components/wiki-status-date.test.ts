import { describe, expect, test } from "bun:test";
import { judgeStatusDate, readStatusDateInputs, type StatusDateNotChecked } from "../../../wiki/status-date-check.ts";
import { claimCheckUrl, makeStatusDateLoader, statusDateLine, statusDatePillHtml, type StatusDateView } from "./wiki-status-date.ts";

/**
 * The status date line in the article head (first-screen-claims P3). The
 * hand-written answers are the shapes `judgeStatusDate` returns
 * (`src/wiki/status-date-check.ts`); the last describe feeds the line that
 * function's own verdicts, and its reason table fails to compile when the
 * server gains a reason this file has not decided.
 */
const newest = { pr: "RuneLind/muninn#802", repo: "RuneLind/muninn", n: 802, mergedAt: "2026-11-04T09:12:00Z", mergedDay: "2026-11-04" };
const late: StatusDateView = { verdict: "late", statusDate: "2026-11-03", newest };
const clear: StatusDateView = { verdict: "clear", statusDate: "2026-11-04", newest };

describe("what the line says", () => {
  test("a late status date names the PR and its merge day", () => {
    expect(statusDateLine(late)).toEqual({
      tone: "late",
      text: "⚠ status older than a merged PR (muninn#802, 04.11)",
      title:
        "status_date 2026-11-03 is older than a merge among the page's prs: RuneLind/muninn#802, merged 2026-11-04. The check compares these two dates and reads no status line.",
    });
  });

  test("a status date on or after the last merge says which merge it was compared with", () => {
    expect(statusDateLine(clear)).toEqual({
      tone: "clear",
      text: "status dated on or after its last merged PR (muninn#802, 04.11)",
      title:
        "status_date 2026-11-04 is not older than the newest merge among the page's prs: RuneLind/muninn#802, merged 2026-11-04. The check compares these two dates and reads no status line.",
    });
  });

  test("a page whose PRs are all unmerged says nothing was merged", () => {
    expect(statusDateLine({ verdict: "clear", statusDate: "2026-11-04" })).toEqual({
      tone: "clear",
      text: "status date checked: no merged PR in prs:",
      title: "status_date 2026-11-04; none of the PRs in the page's prs: is merged, so there is no merge date to compare it with. The check reads no status line.",
    });
  });

  test("no line reads as a verdict on the page: none says ✓, stale or current", () => {
    const all = [late, clear, { verdict: "clear", statusDate: "2026-11-04" }, ...["not-asked", "auth", "no-gh", "unreadable-prs", "no-status-date"].map((reason) => ({ verdict: "notChecked", reason }))];
    for (const v of all) {
      const l = statusDateLine(v)!;
      expect(l.text).toMatch(/status date|status older|status dated/);
      expect(`${l.text} ${l.title}`).not.toMatch(/✓|nothing stale|up to date|current|correct|verified/i);
    }
  });

  const NOT_CHECKED: [reason: string, extra: Partial<StatusDateView>, text: string, title: string][] = [
    ["not-asked", {}, "status date not checked: no PR state on hand", "No state under an hour old is on hand for at least one of this page's PRs. This line reads what the work map card's check got from GitHub and asks nothing itself."],
    ["auth", { repos: ["Acme/Gears", "acme/widgets"] }, "status date not checked: no GitHub access", "Within the last hour GitHub did not let the gh command here read Acme/Gears, acme/widgets: not logged in, no access, or no such repo."],
    ["auth", {}, "status date not checked: no GitHub access", "Within the last hour GitHub did not let the gh command here read a repo in the page's prs:: not logged in, no access, or no such repo."],
    ["no-gh", {}, "status date not checked: no gh command", "The gh command is not installed where muninn runs, so GitHub was not asked."],
    ["unreadable-prs", { unreadable: ["soon", "#12"] }, "status date not checked: prs: holds an entry that is no PR", "Not a PR reference: soon, #12."],
    ["unreadable-prs", {}, "status date not checked: prs: holds an entry that is no PR", "An entry in the page's prs: is not a PR reference."],
    ["no-status-date", {}, "status date not checked: the page has no status_date", "The page lists PRs in prs: but has no status_date to compare with their merges."],
  ];
  for (const [reason, extra, text, title] of NOT_CHECKED) {
    test(`not checked, ${reason}${Object.keys(extra).length ? " with its list" : ""}: says why`, () => {
      expect(statusDateLine({ verdict: "notChecked", reason, ...extra })).toEqual({ tone: "unchecked", text, title });
    });
  }

  test("nothing where nothing could be compared: no prs:, a page the check does not read, no answer", () => {
    for (const v of [
      null,
      undefined,
      {},
      { error: "the status date check failed" },
      { verdict: "notChecked", reason: "no-prs" },
      { verdict: "notChecked", reason: "not-live" },
      { verdict: "notChecked", reason: "a reason from a later server" },
      { verdict: "notChecked" },
      { verdict: "a verdict from a later server", statusDate: "2026-11-04", newest },
      // A late or clear answer that lost a field says nothing, never half a line.
      { verdict: "late", statusDate: "2026-11-03" },
      { verdict: "late", newest },
      { verdict: "clear" },
      { ...late, error: "x" },
      // So does one whose merge lost its PR or its day, or carries a field of the wrong type.
      { ...late, newest: {} },
      { ...late, newest: { repo: "RuneLind/muninn", n: 802, mergedDay: "2026-11-04" } },
      { ...late, newest: { ...newest, mergedDay: "soon" } },
      { ...late, newest: { ...newest, mergedDay: undefined } },
      { ...late, newest: { ...newest, pr: 802 } },
      { ...late, statusDate: 20261103 },
      { ...clear, newest: {} },
      { ...clear, newest: { ...newest, pr: "" } },
      { ...clear, statusDate: null },
    ] as (StatusDateView | null | undefined)[]) {
      expect(statusDateLine(v)).toBeNull();
      expect(statusDatePillHtml(v)).toBe("");
    }
  });

  test("the merge label falls back to the full PR when the repo or the number is missing or of the wrong type", () => {
    const pr = "RuneLind/muninn#802";
    for (const n of [{ pr, mergedDay: "2026-11-04" }, { pr, n: 802, mergedDay: "2026-11-04" }, { pr, repo: "RuneLind/muninn", mergedDay: "2026-11-04" }, { pr, repo: 7, n: 802, mergedDay: "2026-11-04" }, { pr, repo: "RuneLind/muninn", n: "802", mergedDay: "2026-11-04" }]) {
      expect(statusDateLine({ ...late, newest: n } as unknown as StatusDateView)!.text).toBe("⚠ status older than a merged PR (RuneLind/muninn#802, 04.11)");
    }
    expect(statusDateLine({ ...clear, newest: { pr: "muninn#7", repo: "muninn", n: 7, mergedDay: "2026-01-09" } })!.text).toBe("status dated on or after its last merged PR (muninn#7, 09.01)");
  });
});

describe("the line in the pill slot", () => {
  test("one span with its tone, its text and the two dates on hover, escaped", () => {
    expect(statusDatePillHtml(late)).toBe(
      `<span class="wiki-status-date late" data-status-date="late" title="status_date 2026-11-03 is older than a merge among the page&#39;s prs: RuneLind/muninn#802, merged 2026-11-04. The check compares these two dates and reads no status line.">⚠ status older than a merged PR (muninn#802, 04.11)</span>`,
    );
    const hostile = statusDatePillHtml({ verdict: "notChecked", reason: "unreadable-prs", unreadable: ['"><img src=x>'] });
    expect(hostile).not.toContain("<img");
    expect(hostile).toContain("&lt;img");
    expect(statusDatePillHtml({ ...late, newest: { ...newest, repo: "a/<b>" } })).toContain("&lt;b&gt;#802");
  });
});

describe("the server's own verdicts", () => {
  const judge = (statusDate: string, prs: string[], facts: Record<string, { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: string | null }>) => {
    const read = readStatusDateInputs({ prs, status_date: statusDate });
    if (!read.ok) return read.verdict;
    return judgeStatusDate(read.statusDate, read.refs, new Map(Object.entries(facts)), undefined, read.unreadable);
  };
  const merged = { state: "MERGED" as const, mergedAt: "2026-11-04T09:12:00Z" };

  test("late, clear, clear with nothing merged and not asked each give their line", () => {
    expect(statusDateLine(judge("2026-11-03", ["acme/gears#7"], { "acme/gears#7": merged }))!.text).toBe("⚠ status older than a merged PR (gears#7, 04.11)");
    expect(statusDateLine(judge("2026-11-04", ["acme/gears#7"], { "acme/gears#7": merged }))!.text).toBe("status dated on or after its last merged PR (gears#7, 04.11)");
    expect(statusDateLine(judge("2026-11-04", ["acme/gears#7"], { "acme/gears#7": { state: "OPEN", mergedAt: null } }))!.text).toBe("status date checked: no merged PR in prs:");
    expect(statusDateLine(judge("2026-11-04", ["acme/gears#7"], {}))!.text).toBe("status date not checked: no PR state on hand");
    // A later merge is late whatever the other PRs are: the line names a merged PR, never «the last».
    const beside = statusDateLine(judge("2026-11-03", ["acme/gears#7", "other/repo#5"], { "acme/gears#7": merged }))!;
    expect(beside.text).toBe("⚠ status older than a merged PR (gears#7, 04.11)");
    expect(beside.text + beside.title).not.toMatch(/last|newest/);
    expect(statusDateLine(judge("2026-11-04", [], {}))).toBeNull();
  });

  // Exhaustive by type: a reason added to the server's union does not compile here until it is decided.
  const SPOKEN: Record<StatusDateNotChecked, boolean> = {
    "no-prs": false,
    "not-live": false,
    "unreadable-prs": true,
    "no-status-date": true,
    "not-asked": true,
    auth: true,
    "no-gh": true,
  };
  for (const [reason, spoken] of Object.entries(SPOKEN)) {
    test(`reason ${reason}: ${spoken ? "a line" : "no line"}`, () => {
      expect(statusDateLine({ verdict: "notChecked", reason }) !== null).toBe(spoken);
    });
  }
});

describe("an answer of another shape", () => {
  test("gives no line and does not throw into the paint that asked", () => {
    for (const v of [
      { verdict: "notChecked", reason: "auth", repos: "acme/gears" },
      { verdict: "notChecked", reason: "auth", repos: {} },
      { verdict: "notChecked", reason: "unreadable-prs", unreadable: 7 },
      { verdict: "late", statusDate: "2026-11-03", newest: "RuneLind/muninn#802" },
      "late",
      7,
      [],
    ]) {
      expect(statusDatePillHtml(v as unknown as StatusDateView)).toBe("");
    }
    // A list with entries that are no strings keeps the ones that are.
    expect(statusDateLine({ verdict: "notChecked", reason: "auth", repos: ["acme/gears", 7, null, ""] } as unknown as StatusDateView)!.title).toBe(
      "Within the last hour GitHub did not let the gh command here read acme/gears: not logged in, no access, or no such repo.",
    );
  });
});

describe("the loader", () => {
  /** A fetch whose answers are released by hand, in any order. */
  function heldFetch() {
    const calls: { url: string; answer: (status: number, body: unknown) => void; fail: () => void }[] = [];
    const fetchFn = ((url: string) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ url, answer: (status, body) => resolve(new Response(JSON.stringify(body), { status })), fail: () => reject(new Error("offline")) });
      })) as unknown as typeof fetch;
    return { calls, fetchFn };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const setup = (wiki = "w") => {
    const { calls, fetchFn } = heldFetch();
    let answers = 0;
    const loader = makeStatusDateLoader({ wiki: () => wiki, onAnswer: () => answers++, fetch: fetchFn });
    return { calls, loader, answers: () => answers };
  };

  test("asks by the wiki's name and the page's path, and holds the answer for that page only", async () => {
    const s = setup("My Wiki");
    s.loader.load("plans/a b.mdx");
    expect(s.calls.map((c) => c.url)).toEqual(["/api/wiki/claim-check?wiki=My%20Wiki&relPath=plans%2Fa%20b.mdx"]);
    expect(s.loader.answerFor("plans/a b.mdx")).toBeNull();
    s.calls[0]!.answer(200, late);
    await settle();
    expect(s.loader.answerFor("plans/a b.mdx")).toEqual(late);
    expect(s.loader.answerFor("plans/other.mdx")).toBeNull();
    expect(s.loader.answerFor(null)).toBeNull();
    expect(s.answers()).toBe(1);
  });

  test("a wiki with no name and a page that is not markdown are not asked", () => {
    expect(claimCheckUrl("", "plans/a.mdx")).toBeNull();
    expect(claimCheckUrl("w", "explainers/a.html")).toBeNull();
    expect(claimCheckUrl("w", "notes.MD")).toBe("/api/wiki/claim-check?wiki=w&relPath=notes.MD");
    const unnamed = setup("");
    unnamed.loader.load("plans/a.mdx");
    const html = setup();
    html.loader.load("a.html");
    expect([unnamed.calls.length, html.calls.length]).toEqual([0, 0]);
  });

  test("another page forgets the answer at once, and the old page's late answer is dropped", async () => {
    const s = setup();
    s.loader.load("a.mdx");
    s.calls[0]!.answer(200, late);
    await settle();
    s.loader.load("b.mdx");
    expect(s.loader.answerFor("a.mdx")).toBeNull();
    expect(s.loader.answerFor("b.mdx")).toBeNull();
    // Back on a before b's answer arrives: b's answer paints nothing, a is asked again.
    s.loader.load("a.mdx");
    s.calls[1]!.answer(200, clear);
    await settle();
    expect(s.loader.answerFor("a.mdx")).toBeNull();
    expect(s.loader.answerFor("b.mdx")).toBeNull();
    expect(s.answers()).toBe(1);
    s.calls[2]!.answer(200, late);
    await settle();
    expect(s.loader.answerFor("a.mdx")).toEqual(late);
  });

  test("the same page asked twice keeps its answer until the newer one arrives, and an older answer landing last is dropped", async () => {
    const s = setup();
    s.loader.load("a.mdx");
    s.calls[0]!.answer(200, late);
    await settle();
    s.loader.load("a.mdx");
    s.loader.load("a.mdx");
    expect(s.loader.answerFor("a.mdx")).toEqual(late);
    s.calls[2]!.answer(200, clear);
    await settle();
    s.calls[1]!.answer(200, late);
    await settle();
    expect(s.loader.answerFor("a.mdx")).toEqual(clear);
    expect(s.answers()).toBe(2);
  });

  test("a page that is not asked still moves the loader: the page before it gets no late answer", async () => {
    const s = setup();
    s.loader.load("a.mdx");
    s.loader.load("explainers/a.html");
    s.calls[0]!.answer(200, late);
    await settle();
    expect(s.calls).toHaveLength(1);
    expect(s.loader.answerFor("a.mdx")).toBeNull();
    expect(s.loader.answerFor("explainers/a.html")).toBeNull();
    expect(s.answers()).toBe(0);
  });

  test("a refused or failed request leaves no answer, and replaces an older one", async () => {
    const s = setup();
    s.loader.load("a.mdx");
    s.calls[0]!.answer(200, late);
    await settle();
    s.loader.load("a.mdx");
    s.calls[1]!.answer(500, { error: "the status date check failed" });
    await settle();
    expect(s.loader.answerFor("a.mdx")).toBeNull();
    s.loader.load("a.mdx");
    s.calls[2]!.answer(200, late);
    await settle();
    s.loader.load("a.mdx");
    s.calls[3]!.fail();
    await settle();
    expect(s.loader.answerFor("a.mdx")).toBeNull();
    expect(s.answers()).toBe(4);
  });
});
