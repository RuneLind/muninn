/**
 * The chain: the one line under a page title and what it opens into.
 *
 * Three pure layers, each tested where it decides something:
 *
 *  - `chainEvents` — the ORDER. Sessions and merges are one spine sorted by
 *    date, and a dateless event has exactly one defined position (last, in the
 *    page's own `sessions:` order) rather than wherever a comparator happened to
 *    leave it.
 *  - `provLineHtml` — the collapsed line: one sentence (the eight-state family
 *    `costLine` already owns) plus one mark per event, rings before squares.
 *  - `chainHtml` — the rows. A merge row is rendered from the merge's `url`
 *    because the ledger's `repo` is a CHECKOUT PATH, and a row whose repo
 *    `repoUrls` does not name renders unlinked rather than guessing a
 *    coordinate.
 *
 * Times are formatted in an EXPLICIT zone here. The renderer's runtime default
 * is the viewer's own zone, which would make every assertion on an hour a
 * function of the machine the suite runs on — green in Oslo, red on a UTC CI
 * runner.
 */

import { describe, expect, test } from "bun:test";
import {
  CHAIN_ID,
  chainEvents,
  chainHtml,
  fmtChainStamp,
  MARKS_MAX,
  MERGE_UNCONFIRMED_COPY,
  MERGES_PARTIAL_NOTE,
  MERGES_UNREACHABLE_NOTE,
  mergesCutNote,
  provLineHtml,
  provStripHtml,
  railListHtml,
} from "./wiki-provenance-view.ts";
import type {
  ProvenanceMerge,
  ProvenancePayload,
  ProvenanceSessionChip,
} from "../../../wiki/provenance.ts";

const UTC = { timeZone: "UTC" } as const;

function chip(over: Partial<ProvenanceSessionChip> = {}): ProvenanceSessionChip {
  return {
    ref: "claude-code:abc",
    provider: "claude-code",
    id: "abc",
    title: null,
    host: null,
    first: null,
    last: null,
    cost: null,
    messages: null,
    missing: false,
    unresolved: false,
    invalid: false,
    ...over,
  };
}

function merge(over: Partial<ProvenanceMerge> = {}): ProvenanceMerge {
  return {
    sessionId: "abc",
    repo: "/Users/rune/source/private/muninn",
    prNumber: 553,
    url: "https://github.com/RuneLind/muninn/pull/553",
    subject: null,
    mergedAt: "2026-09-16T10:30:00.000Z",
    mergeOk: true,
    ...over,
  };
}

function payload(over: Partial<ProvenancePayload> = {}): ProvenancePayload {
  return {
    sessions: [],
    jira: [],
    prs: [],
    merges: [],
    totalCost: 0,
    costedSessions: 0,
    ledger: { asked: true, reachable: true, partial: false, configured: true },
    mergesLedger: { asked: true, reachable: true, partial: false, truncated: false },
    ...over,
  };
}

/** A priced session, a bare one and two merges — the mixed dated/dateless
 *  fixture every ordering assertion below reads. */
function mixed(): ProvenancePayload {
  return payload({
    sessions: [
      // Dated, and the LATER of the two — so a comparator that kept input order
      // renders it first and fails.
      chip({ id: "second", first: "2026-09-15T20:22:00.000Z", last: "2026-09-16T07:12:00.000Z", cost: 35.7 }),
      // Dateless: the shape fixture's `missing` chip, and the damaged-ref
      // spec's `invalid` one, both land here.
      chip({ id: "bare-a", missing: true }),
      chip({ id: "first", first: "2026-09-15T18:10:00.000Z", cost: 50.95 }),
      chip({ id: "bare-b", invalid: true }),
    ],
    merges: [
      merge({ sessionId: "second", prNumber: 553, mergedAt: "2026-09-16T06:00:00.000Z" }),
      merge({ sessionId: "second", prNumber: 552, mergedAt: "2026-09-15T20:55:00.000Z" }),
    ],
    // What `costOfSessions` would have summed over the two priced chips.
    totalCost: 86.65,
    costedSessions: 2,
  });
}

/**
 * The chain's rows in order, each named the way the reader sees it: a session by
 * the id in its `<code>`, a merge by the text of its PR element.
 *
 * Split on the row class rather than matched with one pattern, so a row that
 * renders NEITHER (the shape a missing final `else` used to produce) shows up as
 * an empty string instead of vanishing from the list.
 */
function rowLabels(html: string): string[] {
  return html
    .split(`<div class="wiki-chain-row`)
    .slice(1)
    .map((row) => {
      const id = /<code class="wiki-chain-id">([^<]*)<\/code>/.exec(row);
      if (id) return id[1]!;
      const pr = /<(?:a|span) class="wiki-chain-pr"[^>]*>([^<]*)</.exec(row);
      return pr ? pr[1]! : "";
    });
}

describe("fmtChainStamp", () => {
  test("`MM-DD HH:MM` in the zone it is given, from the ledger's ISO stamp", () => {
    expect(fmtChainStamp("2026-09-15T18:10:36.010Z", "UTC")).toBe("09-15 18:10");
    // The same instant, two hours east — the viewer's zone is what the runtime
    // default resolves to, so the function must actually apply one.
    expect(fmtChainStamp("2026-09-15T18:10:36.010Z", "Europe/Oslo")).toBe("09-15 20:10");
  });

  test("midnight is 00:00, never 24:00", () => {
    // Measured on bun 1.3.10 under en-GB: `hourCycle: "h24"` renders this hour
    // as `24` and `h12` as `12`, so both wrong answers are one option away —
    // which is what naming the cycle in the renderer buys.
    expect(fmtChainStamp("2026-09-16T00:00:00.000Z", "UTC")).toBe("09-16 00:00");
  });

  test("a value that is not a stamp renders as nothing rather than `Invalid Date`", () => {
    expect(fmtChainStamp("not-a-date", "UTC")).toBe("");
    expect(fmtChainStamp(null, "UTC")).toBe("");
  });
});

describe("chainEvents", () => {
  test("ascending by date, sessions and merges on ONE spine", () => {
    const events = chainEvents(mixed());
    expect(events.map((e) => (e.kind === "session" ? e.chip.id : `#${e.merge.prNumber}`))).toEqual([
      "first", // 09-15 18:10
      "second", // 09-15 20:22
      "#552", // 09-15 20:55
      "#553", // 09-16 06:00
      "bare-a",
      "bare-b",
    ]);
  });

  test("a dateless event sorts LAST and keeps the page's `sessions:` order", () => {
    const events = chainEvents(mixed());
    const dateless = events.slice(-2);
    expect(dateless.every((e) => e.at === null)).toBe(true);
    // `bare-a` is listed before `bare-b` on the page; nothing about the ledger
    // reorders them.
    expect(dateless.map((e) => (e.kind === "session" ? e.chip.id : ""))).toEqual(["bare-a", "bare-b"]);
    // And every DATED event is above them.
    expect(events.slice(0, -2).every((e) => e.at !== null)).toBe(true);
  });

  test("a session with only `last` is dated by it — the `first ?? last` fallback", () => {
    const events = chainEvents(
      payload({
        sessions: [chip({ id: "only-last", first: null, last: "2026-09-14T09:00:00.000Z" })],
        merges: [merge({ mergedAt: "2026-09-16T10:30:00.000Z" })],
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["session", "merge"]);
    expect(events[0]!.at).toBe("2026-09-14T09:00:00.000Z");
  });

  test("a merge with no `mergedAt` is dateless too, and sorts after the dated rows", () => {
    const events = chainEvents(
      payload({
        sessions: [chip({ id: "s", first: "2026-09-15T18:00:00.000Z" })],
        merges: [merge({ mergedAt: null })],
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["session", "merge"]);
    expect(events[1]!.at).toBe(null);
  });

  test("a session and a merge at the SAME instant keep input order — session first", () => {
    const at = "2026-09-15T18:00:00.000Z";
    const events = chainEvents(
      payload({ sessions: [chip({ id: "s", first: at })], merges: [merge({ mergedAt: at })] }),
    );
    expect(events.map((e) => e.kind)).toEqual(["session", "merge"]);
  });

  test("a payload from a server that sent no merges at all is sessions only", () => {
    const p = payload({ sessions: [chip({ id: "s" })] });
    // The wire loses a key the server left undefined, so the reader must not
    // index into it.
    delete (p as { merges?: unknown }).merges;
    expect(chainEvents(p).map((e) => e.kind)).toEqual(["session"]);
  });
});

describe("provLineHtml", () => {
  test("the whole sentence is ONE collapsed disclosure button", () => {
    const html = provLineHtml(mixed());
    expect(html).toContain("<button");
    expect(html).toContain(`aria-expanded="false"`);
    expect(html).toContain(`data-prov-toggle`);
    // The sentence family is `costLine`'s, unchanged.
    expect(html).toContain("the 4 sessions that wrote this page cost $86.65 in total over 2 of 4");
  });

  test("one ring per session then one square per merge, in that order", () => {
    const html = provLineHtml(mixed());
    const marks = [...html.matchAll(/data-mark="([a-z]+)"/g)].map((m) => m[1]);
    expect(marks).toEqual(["session", "session", "session", "session", "merge", "merge"]);
  });

  test("marks are rendered for every ledger state, merges included or not", () => {
    // Unconfigured host: the sentence changes, the rings do not, and there is no
    // merges leg to draw a square from.
    const unconfigured = payload({
      sessions: [chip({ id: "a", unresolved: true }), chip({ id: "b", unresolved: true })],
      ledger: { asked: false, reachable: false, partial: false, configured: false },
      mergesLedger: { asked: false, reachable: false, partial: false, truncated: false },
    });
    const html = provLineHtml(unconfigured);
    expect(html).toContain("2 sessions wrote this page — no claude-usage on this host");
    expect([...html.matchAll(/data-mark="([a-z]+)"/g)].map((m) => m[1])).toEqual([
      "session",
      "session",
    ]);
  });

  test("every mark carries a hover — a glyph alone says nothing", () => {
    const html = provLineHtml(mixed());
    // The space is load-bearing: `wiki-prov-marks` is the CONTAINER, and a
    // pattern that matched it counted one mark too many.
    const marks = [...html.matchAll(/<span class="wiki-prov-mark [^>]*>/g)].map((m) => m[0]);
    expect(marks.length).toBe(6);
    expect(marks.every((m) => m.includes("title="))).toBe(true);
    expect(marks.some((m) => m.includes("#553"))).toBe(true);
  });

  test("no sentence, no line — a page carrying only a Jira key gets nothing here", () => {
    expect(provLineHtml(payload({ ledger: { asked: false, reachable: false, partial: false, configured: true } }))).toBe("");
  });
});

describe("chainHtml", () => {
  test("a priced session row: when · host, money, title, id, copy and drill-down", () => {
    const html = chainHtml(
      payload({
        sessions: [
          chip({
            id: "5a2ee3f0",
            host: "macpro",
            title: "Execute PR 1 of the plan",
            first: "2026-09-15T18:10:00.000Z",
            last: "2026-09-15T20:04:00.000Z",
            cost: 12.34,
            messages: 148,
            url: "https://usage.example.test/#/session/5a2ee3f0",
          }),
        ],
      }),
      UTC,
    );
    expect(html).toContain("wiki-chain-row");
    expect(html).toContain("09-15 18:10 → 09-15 20:04");
    expect(html).toContain("macpro");
    expect(html).toContain("$12.34");
    expect(html).toContain("Execute PR 1 of the plan");
    expect(html).toContain(`<code class="wiki-chain-id">5a2ee3f0</code>`);
    // The copy contract the client's delegate is keyed on — unchanged from the
    // rail rows this replaces.
    expect(html).toContain(`data-sess-copy="5a2ee3f0"`);
    expect(html).toContain(`aria-label="Copy the session id 5a2ee3f0"`);
    expect(html).toContain(`href="https://usage.example.test/#/session/5a2ee3f0"`);
    // The message count is a hover, not a column.
    expect(html).toContain("148 messages");
  });

  test("a session the instance cannot link renders the id without an ↗", () => {
    const html = chainHtml(payload({ sessions: [chip({ id: "x", cost: 1, first: "2026-09-15T10:00:00.000Z" })] }), UTC);
    expect(html).toContain(`data-sess-copy="x"`);
    expect(html).not.toContain("wiki-chain-link");
  });

  test("a bare row says its reason, and carries neither money nor a link", () => {
    const html = chainHtml(payload({ sessions: [chip({ id: "ses_7f3a", missing: true })] }), UTC);
    expect(html).toContain("wiki-chain-bare");
    expect(html).toContain("not in the ledger — reaped, or from another host");
    expect(html).toContain(`data-sess-copy="ses_7f3a"`);
    expect(html).not.toContain("wiki-chain-cost");
    expect(html).not.toContain("wiki-chain-link");
  });

  test("a merge row is rendered from the URL — the ledger's `repo` is a checkout path", () => {
    const html = chainHtml(payload({ merges: [merge()] }), UTC);
    expect(html).toContain(`href="https://github.com/RuneLind/muninn/pull/553"`);
    expect(html).toContain("RuneLind/muninn #553");
    expect(html).toContain("merged 09-16 10:30");
    // The checkout path is never shown as if it were a coordinate.
    expect(html).not.toContain("/Users/rune");
  });

  test("a merge whose repo `repoUrls` does not name renders unlinked, with the basename as a hover", () => {
    const html = chainHtml(payload({ merges: [merge({ url: null })] }), UTC);
    expect(html).toContain("#553");
    expect(html).toContain("merged 09-16 10:30");
    // No link at all — a plausible-looking coordinate guessed from a checkout
    // path is the worst output this row can have.
    expect(html).not.toContain("github.com");
    expect(html).not.toContain("<a ");
    // The basename says WHICH checkout, without claiming it is an owner/repo.
    expect(html).toContain(`title="muninn"`);
  });

  test("an unconfirmed merge is QUALIFIED, never dropped", () => {
    const html = chainHtml(payload({ merges: [merge({ mergeOk: false })] }), UTC);
    expect(html).toContain("#553");
    expect(html).toContain("merge unconfirmed");
  });

  test("a confirmed merge carries no qualifier", () => {
    expect(chainHtml(payload({ merges: [merge()] }), UTC)).not.toContain("merge unconfirmed");
  });

  test("a bare `gh pr merge` has no number to show and still renders", () => {
    const html = chainHtml(payload({ merges: [merge({ prNumber: null, url: null })] }), UTC);
    expect(html).toContain("wiki-chain-merge");
    expect(html).toContain("merged 09-16 10:30");
    expect(html).not.toContain("#null");
  });

  test("rows come out in the chain's order, merges interleaved", () => {
    const html = chainHtml(mixed(), UTC);
    // Read off the rows THEMSELVES — a session by the id it prints, a merge by
    // the coordinate it prints. The rows carried a `data-chain` attribute for
    // this once, which put a test hook in every reader's markup.
    expect(rowLabels(html)).toEqual([
      "first",
      "second",
      "RuneLind/muninn #552",
      "RuneLind/muninn #553",
      "bare-a",
      "bare-b",
    ]);
  });

  test("the merges footer names the leg that failed, and only when it failed", () => {
    const ok = chainHtml(payload({ sessions: [chip({ id: "a", cost: 1 })] }), UTC);
    expect(ok).not.toContain("merges not shown");

    const down = chainHtml(
      payload({
        sessions: [chip({ id: "a", cost: 1 })],
        mergesLedger: { asked: true, reachable: false, partial: false, truncated: false },
      }),
      UTC,
    );
    expect(down).toContain(MERGES_UNREACHABLE_NOTE);
    expect(MERGES_UNREACHABLE_NOTE).toBe("merges not shown: claude-usage did not answer");

    const cut = chainHtml(
      payload({
        sessions: [chip({ id: "a", cost: 1 })],
        merges: [merge()],
        mergesLedger: { asked: true, reachable: true, partial: false, truncated: true, limit: 500 },
      }),
      UTC,
    );
    // The cap is UPSTREAM's own number, off the payload — and the note does not
    // say "not shown" beside the rows it is standing under.
    expect(cut).toContain("merges list cut at 500 by claude-usage");
    expect(mergesCutNote(500)).toBe("merges list cut at 500 by claude-usage");
    expect(mergesCutNote(undefined)).toBe("merges list cut by claude-usage");
  });

  test("a host with no claude-usage has no merges footer — nothing was asked", () => {
    const html = chainHtml(
      payload({
        sessions: [chip({ id: "a", unresolved: true })],
        ledger: { asked: false, reachable: false, partial: false, configured: false },
        mergesLedger: { asked: false, reachable: false, partial: false, truncated: false },
      }),
      UTC,
    );
    expect(html).not.toContain("merges not shown");
  });

  test("every ledger-supplied string is escaped", () => {
    const html = chainHtml(
      payload({
        sessions: [chip({ id: "a", title: `<img src=x onerror=1>`, host: `<b>`, cost: 1 })],
        merges: [merge({ url: `https://x/"><img src=y>`, repo: `<svg>` })],
      }),
      UTC,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg>");
    expect(html).not.toContain("<b>");
  });
});

describe("the marks are bounded", () => {
  /** N sessions, every one of them dated and priced. */
  function manySessions(n: number): ProvenancePayload {
    return payload({
      sessions: Array.from({ length: n }, (_, i) =>
        chip({ id: `s${i}`, first: `2026-09-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`, cost: 1 }),
      ),
      totalCost: n,
      costedSessions: n,
    });
  }

  const markCount = (html: string) => [...html.matchAll(/<span class="wiki-prov-mark /g)].length;

  test(`no more than ${MARKS_MAX} marks, however many events the page has`, () => {
    // MEASURED before the cap: 61 marks painted 213 px past the article column
    // and took the caret out of it.
    const html = provLineHtml(manySessions(60), UTC);
    expect(markCount(html)).toBe(MARKS_MAX + 1); // the cap, plus the `+N` tail
    expect([...html.matchAll(/data-mark="session"/g)].length).toBe(MARKS_MAX);
  });

  test("the tail mark counts what it hid, and says so on hover", () => {
    const html = provLineHtml(manySessions(60), UTC);
    expect(html).toContain(`data-mark="more"`);
    expect(html).toContain(`>+36</span>`);
    expect(html).toContain("36 more events");
  });

  test("one event past the cap is `+1`, singular", () => {
    const html = provLineHtml(manySessions(MARKS_MAX + 1), UTC);
    expect(html).toContain(`>+1</span>`);
    expect(html).toContain("1 more event — open the line to see it");
  });

  test("exactly the cap renders no tail at all", () => {
    const html = provLineHtml(manySessions(MARKS_MAX), UTC);
    expect(markCount(html)).toBe(MARKS_MAX);
    expect(html).not.toContain(`data-mark="more"`);
  });

  test("the chain below still lists EVERY event — the cap is on the marks alone", () => {
    expect(rowLabels(chainHtml(manySessions(60), UTC)).length).toBe(60);
  });
});

describe("the strip hands its render options to BOTH halves", () => {
  // Two zones either side of the date line, so a dropped `opts` cannot pass by
  // coincidence on whichever machine runs the suite.
  const AT = "2026-09-15T14:00:00.000Z";
  const FAR_EAST = "Pacific/Kiritimati"; // UTC+14

  test("a session mark's hover renders in the REQUESTED zone, like the row below it", () => {
    expect(fmtChainStamp(AT, FAR_EAST)).toBe("09-16 04:00");
    const p = payload({ sessions: [chip({ id: "s", first: AT, cost: 1 })], totalCost: 1, costedSessions: 1 });
    const html = provStripHtml(p, null, { timeZone: FAR_EAST });
    const mark = /<span class="wiki-prov-mark [^>]*title="([^"]*)"/.exec(html);
    expect(mark).not.toBeNull();
    // The mark and the row are two spellings of ONE instant; rendering them in
    // different zones is the one way this line can contradict itself.
    expect(mark![1]).toContain("09-16 04:00");
    expect(html).toMatch(/class="wiki-chain-when"[^>]*>09-16 04:00</);
  });
});

describe("row cosmetics", () => {
  test("a priced session with no date does not open with a stray separator", () => {
    const html = chainHtml(payload({ sessions: [chip({ id: "s", host: "macmini", cost: 1 })] }), UTC);
    // The `·` separates the host from the date BEFORE it; with no date it read
    // `◇ · macmini`.
    expect(html).toContain(`<span class="wiki-chain-host">macmini</span>`);
    expect(html).not.toContain("· macmini");
  });

  test("a dated session still separates its host from the date", () => {
    const html = chainHtml(
      payload({ sessions: [chip({ id: "s", host: "macmini", first: "2026-09-15T10:00:00.000Z", cost: 1 })] }),
      UTC,
    );
    expect(html).toContain(`<span class="wiki-chain-host">· macmini</span>`);
  });

  test("a session that ran inside a minute hovers ONE stamp, not `X → X`", () => {
    const at = "2026-09-15T10:00:00.000Z";
    const html = chainHtml(payload({ sessions: [chip({ id: "s", first: at, last: at, cost: 1 })] }), UTC);
    expect(html).toContain(`title="${at}"`);
    expect(html).not.toContain(`${at} → ${at}`);
  });

  test("two different instants still hover both ends", () => {
    const html = chainHtml(
      payload({
        sessions: [chip({ id: "s", first: "2026-09-15T10:00:00.000Z", last: "2026-09-15T11:00:00.000Z", cost: 1 })],
      }),
      UTC,
    );
    expect(html).toContain(`title="2026-09-15T10:00:00.000Z → 2026-09-15T11:00:00.000Z"`);
  });

  test("a merge the ledger holds nothing but a session id for still says what it is", () => {
    // No number, no url, no repo — the shape the removed `else if` dropped on
    // the floor, leaving a row that was one glyph and no words.
    const html = chainHtml(
      payload({ merges: [merge({ prNumber: null, url: null, repo: "", mergedAt: null })] }),
      UTC,
    );
    expect(rowLabels(html)).toEqual(["a merge"]);
    expect(html).not.toContain("<a ");
  });

  test("a date-only stamp is a DATE — never a time, and never the day before", () => {
    // `Date.parse("2026-09-15")` is UTC midnight, so formatting it anywhere west
    // of UTC rendered `09-14`. There is no hour in the input to render anyway.
    expect(fmtChainStamp("2026-09-15", "Pacific/Midway")).toBe("09-15");
    expect(fmtChainStamp("2026-09-15", "Pacific/Kiritimati")).toBe("09-15");
    expect(fmtChainStamp("2026-09-15", UTC.timeZone)).toBe("09-15");
    // A full stamp is unchanged — it carries the hour the reader asked for.
    expect(fmtChainStamp("2026-09-15T18:10:00.000Z", UTC.timeZone)).toBe("09-15 18:10");
  });

  test("a url that is not a github pull request is never turned into a link", () => {
    // A REGRESSION GUARD, green before this round: `mergeCoordinate` matched
    // github.com only, and nothing proved it — mutating the pattern to accept
    // any url left the file green.
    const html = chainHtml(
      payload({ merges: [merge({ url: "https://gitlab.com/acme/widget/-/merge_requests/9" })] }),
      UTC,
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("gitlab.com");
    expect(html).toContain("#553");
  });
});

describe("the merges footer's third state", () => {
  const partial = (over: Partial<ProvenancePayload> = {}) =>
    payload({
      sessions: [chip({ id: "a", cost: 1 })],
      merges: [merge()],
      mergesLedger: { asked: true, reachable: true, partial: true, truncated: false },
      totalCost: 1,
      costedSessions: 1,
      ...over,
    });

  test("a leg that answered for SOME sessions says so — the rows are real, and incomplete", () => {
    const html = chainHtml(partial(), UTC);
    expect(html).toContain(MERGES_PARTIAL_NOTE);
    expect(MERGES_PARTIAL_NOTE).toBe(
      "merges may be incomplete: claude-usage answered for some sessions only",
    );
    // NOT the sentence for a leg that answered nothing: this page is showing a
    // merge row while it says it.
    expect(html).not.toContain(MERGES_UNREACHABLE_NOTE);
    expect(html).toContain("RuneLind/muninn #553");
  });

  test("a leg that answered NOTHING outranks partial", () => {
    const html = chainHtml(
      partial({ mergesLedger: { asked: true, reachable: false, partial: true, truncated: false } }),
      UTC,
    );
    expect(html).toContain(MERGES_UNREACHABLE_NOTE);
    expect(html).not.toContain(MERGES_PARTIAL_NOTE);
  });

  test("partial outranks a cut list — a missing batch is the bigger hole", () => {
    const html = chainHtml(
      partial({ mergesLedger: { asked: true, reachable: true, partial: true, truncated: true, limit: 200 } }),
      UTC,
    );
    expect(html).toContain(MERGES_PARTIAL_NOTE);
    expect(html).not.toContain("list cut");
  });
});

describe("the module's own contracts", () => {
  test("the disclosure points at the chain it opens, by the id the chain carries", () => {
    const p = payload({ sessions: [chip({ id: "a", cost: 1 })], totalCost: 1, costedSessions: 1 });
    expect(provLineHtml(p, UTC)).toContain(`aria-controls="${CHAIN_ID}"`);
    expect(chainHtml(p, UTC)).toContain(`id="${CHAIN_ID}"`);
  });

  test("the unconfirmed qualifier is ONE string, shared by the row and its reader", () => {
    expect(chainHtml(payload({ merges: [merge({ mergeOk: false })] }), UTC)).toContain(
      MERGE_UNCONFIRMED_COPY,
    );
    expect(MERGE_UNCONFIRMED_COPY).toBe("merge unconfirmed");
  });
});

describe("railListHtml", () => {
  test("the empty state is decided on the page rows ALONE", () => {
    // The rule #550's fix round established, kept after the Sessions section
    // left the rail: nothing else may stand in for "No pages match."
    expect(railListHtml("")).toContain("No pages match.");
    expect(railListHtml("<div>row</div>")).toBe("<div>row</div>");
  });
});
