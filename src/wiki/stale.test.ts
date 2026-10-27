import { test, expect, describe } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bucketFor,
  isLivingPage,
  linkingBuckets,
  linkingCounts,
  movedWith,
  pageLastChangeMs,
  parseStaleAsOf,
  passageClaim,
  resolveStatusLineHits,
  staleSummary,
  stalePageReport,
  statusLineCandidates,
  statusWordsIn,
  type StatusLineCandidate,
} from "./stale.ts";
import { buildWikiIndex, type WikiIndex, type WikiPageMeta } from "./store.ts";
import { lintWiki } from "./lint.ts";
import { testTempDir } from "../test/temp-dir.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-06-15T12:00:00Z");

describe("status words (D18)", () => {
  test("English and Norwegian, with edges that hold on æøå", () => {
    expect(statusWordsIn("is shipped now")).toEqual(["shipped"]);
    expect(statusWordsIn("arbeidet pågår")).toEqual(["in-flight"]);
    expect(statusWordsIn("en åpen PR")).toEqual(["in-flight"]);
    expect(statusWordsIn("foreslått i går")).toEqual(["proposed"]);
    expect(statusWordsIn("blokkert av X")).toEqual(["blocked"]);
    // A word inside a longer word is no status word.
    expect(statusWordsIn("undone, shippedness, draftsman")).toEqual([]);
    expect(statusWordsIn("ferdigheter")).toEqual([]);
  });

  test("merget and merged are shipped unless negated, and the negation is in-flight", () => {
    expect(statusWordsIn("PR-en er merget")).toEqual(["shipped"]);
    expect(statusWordsIn("ikke merget ennå")).toEqual(["in-flight"]);
    expect(statusWordsIn("not merged")).toEqual(["in-flight"]);
    expect(statusWordsIn("merged into main")).toEqual(["shipped"]);
  });
});

const fm = (extra = "") => `---\ntitle: Page\n${extra}---\n`;

describe("statusLineCandidates (phase A)", () => {
  test("a status word between a link and the next link on its line", () => {
    const c = statusLineCandidates(`${fm()}\n- [[plan-a]] is shipped, see [[plan-b]] for the rest\n`);
    expect(c.map((x) => [x.line, x.target, x.said])).toEqual([[5, "plan-a", ["shipped"]]]);
  });

  test("anchor and escapes are dropped from the target; a bare anchor is no target", () => {
    const c = statusLineCandidates("[[plan-a#Status|the plan]] is blocked. [[#local]] is done\n");
    expect(c.map((x) => x.target)).toEqual(["plan-a"]);
  });

  test("check 14's masks: fences, blockquotes, table headers, history blocks", () => {
    const body = [
      fm(),
      "```",
      "[[plan-a]] shipped",
      "```",
      "> [[plan-a]] shipped",
      "",
      "| [[plan-a]] shipped | b |",
      "|---|---|",
      "| [[plan-a]] blocked | b |",
      "",
      "<Timeline>",
      "- [[plan-a]] proposed",
      "</Timeline>",
      "",
      "<Historic>",
      "[[plan-a]] proposed",
      "</Historic>",
      "",
      "[[plan-a]] in-flight",
    ].join("\n");
    const c = statusLineCandidates(body);
    expect(c.map((x) => x.said[0])).toEqual(["blocked", "in-flight"]);
  });

  test("a Status home is NOT exempt — that is where a stale status sits", () => {
    const c = statusLineCandidates(`${fm()}\n**Status:** [[plan-a]] is shipped.\n`);
    expect(c).toHaveLength(1);
  });

  test("this check's own exemptions: inline code, strikethrough, title/description/status_note, a markdown link in the segment", () => {
    const body = [
      "---",
      "title: About [[plan-a]] shipped",
      "description: >",
      "  [[plan-a]] shipped",
      "status_note: [[plan-a]] shipped",
      "tags: [x]",
      "---",
      "`[[plan-a]] shipped` in code",
      "~~[[plan-a]] shipped~~ struck",
      "[[plan-a]] ~~shipped~~ struck word",
      "[[plan-a]] see [notes](x.md) shipped",
      "[[plan-a]] shipped for real",
    ].join("\n");
    const c = statusLineCandidates(body);
    expect(c.map((x) => x.line)).toEqual([12]);
  });

  test("a markdown link the masks remove does not drop the segment (F1)", () => {
    // The `](` sits inside inline code or a struck span: masked away, so the
    // segment holds no markdown link and the status word is a candidate.
    expect(statusLineCandidates("[[plan-a]] is in-flight, see `[x](y.md)`\n").map((x) => x.said)).toEqual([["in-flight"]]);
    expect(statusLineCandidates("[[plan-a]] is in-flight ~~[old](y.md)~~\n").map((x) => x.said)).toEqual([["in-flight"]]);
  });

  test("a struck span holding inline code or a single `~` is struck whole (F1)", () => {
    expect(statusLineCandidates("[[plan-a]] ~~shipped `v2`~~ in-flight\n").map((x) => x.said)).toEqual([["in-flight"]]);
    expect(statusLineCandidates("[[plan-a]] ~~shipped ~1 day~~ in-flight\n").map((x) => x.said)).toEqual([["in-flight"]]);
  });

  test("an HTML comment hides its text, on one line or across lines (F1)", () => {
    const body = [
      fm(),
      "<!-- [[plan-a]] in-flight -->",
      "<!--",
      "[[plan-a]] blocked",
      "-->",
      "`<!--` [[plan-a]] shipped",
      "x --> [[plan-a]] proposed <!-- [[plan-a]] blocked",
      "[[plan-a]] blocked -->",
    ].join("\n");
    expect(statusLineCandidates(body).map((x) => [x.line, x.said])).toEqual([
      [9, ["shipped"]],
      [10, ["proposed"]],
    ]);
  });

  test("no `[[` or no status word: nothing, and no masks paid", () => {
    expect(statusLineCandidates("shipped and done\n")).toEqual([]);
    expect(statusLineCandidates("[[plan-a]] and [[plan-b]]\n")).toEqual([]);
    // A status word BEFORE the link names nothing about it.
    expect(statusLineCandidates("shipped: [[plan-a]]\n")).toEqual([]);
  });
});

function meta(over: Partial<WikiPageMeta> & { relPath: string }): WikiPageMeta {
  return { name: path.posix.basename(over.relPath).replace(/\.mdx?$/, ""), title: over.relPath, type: "note", domain: "ai", tags: [], aliases: [], ...over };
}

describe("resolveStatusLineHits (phase B)", () => {
  const plans: Record<string, WikiPageMeta> = {
    a: meta({ relPath: "plans/a.md", plan_status: "in-flight" }),
    r: meta({ relPath: "plans/r.md", plan_status: "ready" }),
    s: meta({ relPath: "plans/s.md", plan_status: "superseded" }),
    n: meta({ relPath: "notes/n.md" }),
  };
  const resolve = (t: string) => plans[t];
  const cand = (target: string, said: StatusLineCandidate["said"], line = 3): StatusLineCandidate => ({ line, target, said, text: "x" });

  test("a status that disagrees is a hit; naming the current one too passes", () => {
    const hits = resolveStatusLineHits("notes/x.md", [cand("a", ["shipped"]), cand("a", ["shipped", "in-flight"], 4)], resolve);
    expect(hits.map((h) => [h.line, h.target, h.now])).toEqual([[3, "plans/a.md", "in-flight"]]);
  });

  test("ready reads as proposed; superseded targets and pages without plan_status are skipped", () => {
    expect(resolveStatusLineHits("notes/x.md", [cand("r", ["proposed"]), cand("s", ["shipped"]), cand("n", ["shipped"])], resolve)).toEqual([]);
    expect(resolveStatusLineHits("notes/x.md", [cand("r", ["shipped"])], resolve)).toHaveLength(1);
  });

  test("a page's line about itself is no hit, and one hit per line and target", () => {
    expect(resolveStatusLineHits("plans/a.md", [cand("a", ["shipped"])], resolve)).toEqual([]);
    expect(resolveStatusLineHits("notes/x.md", [cand("a", ["shipped"]), cand("a", ["blocked"])], resolve)).toHaveLength(1);
  });
});

describe("living pages and history (D4)", () => {
  test("archive and blog paths, history types, closed plans, reserved and culled pages are not living", () => {
    expect(isLivingPage(meta({ relPath: "plans/a.md", plan_status: "in-flight" }))).toBe(true);
    expect(isLivingPage(meta({ relPath: "archive/x/a.md" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "blogs/a.mdx" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "notes/a.md", type: "report" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "plans/a.md", plan_status: "shipped" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "plans/index.md" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "notes/a.md", culled: true }))).toBe(false);
  });
});

describe("pageLastChangeMs (D29)", () => {
  const p = (over: Partial<WikiPageMeta>) => meta({ relPath: "a.md", ...over });

  test("the newest of worked, non-sweep commit and — only while dirty — mtime", () => {
    expect(pageLastChangeMs(p({ workedMs: T0, gitTouchedMs: T0 - DAY, mtimeMs: T0 + DAY }))).toBe(T0);
    expect(pageLastChangeMs(p({ gitTouchedMs: T0 - DAY, mtimeMs: T0 + DAY, gitDirty: true }))).toBe(T0 + DAY);
    expect(pageLastChangeMs(p({ mtimeMs: T0 }))).toBeUndefined();
  });

  test("asOf drops newer signals and falls back to the stepped-back commit", () => {
    expect(pageLastChangeMs(p({ gitTouchedMs: T0 + 2 * DAY, workedMs: T0 + DAY }), T0, T0 - 3 * DAY)).toBe(T0 - 3 * DAY);
    expect(pageLastChangeMs(p({ gitTouchedMs: T0 + 2 * DAY }), T0)).toBeUndefined();
  });
});

describe("bucketFor (D5)", () => {
  const changedAtMs = T0;
  const passage = (text: string, over: { inFrontmatter?: boolean; pointerHeading?: boolean } = {}) => ({
    line: 1,
    text,
    inFrontmatter: over.inFrontmatter ?? false,
    pointerHeading: over.pointerHeading ?? false,
    ...(passageClaim(text) ? { claim: passageClaim(text) } : {}),
  });
  const page = meta({ relPath: "notes/a.md" });
  const old = T0 - 10 * DAY;

  test("History is tested first, whatever the dates", () => {
    expect(bucketFor({ page: meta({ relPath: "archive/a.md" }), lastChangeMs: T0 + DAY, changedAtMs, passages: [passage("[[x]] shipped")] })).toBe("history");
    expect(bucketFor({ page: meta({ relPath: "plans/p.md", plan_status: "abandoned" }), lastChangeMs: old, changedAtMs, passages: [] })).toBe("history");
  });

  test("Changed since, then a page inside the 2-day margin is a Mention", () => {
    expect(bucketFor({ page, lastChangeMs: T0 + 1, changedAtMs, passages: [passage("[[x]] shipped")] })).toBe("changedSince");
    expect(bucketFor({ page, lastChangeMs: T0 - DAY, changedAtMs, passages: [passage("[[x]] shipped")] })).toBe("mentions");
  });

  test("older: Pointers when every passage is a pointer", () => {
    expect(bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage("related: [[x]] shipped", { inFrontmatter: true })] })).toBe("pointers");
    expect(bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage("- [[x]] shipped 12.10", { pointerHeading: true })] })).toBe("pointers");
    expect(bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage("- [[x]] — the e2e repo")] })).toBe("pointers");
    // More than 30 characters after the link is no bare item.
    expect(bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage("- [[x]] — the e2e repo and its long story")] })).toBe("mentions");
  });

  test("older: To check on a status word, a date, a PR or an N of M count; else Mentions", () => {
    const at = (text: string) => bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage(text)] });
    expect(at("[[x]] is under arbeid")).toBe("toCheck");
    expect(at("pinned in [[x]] on 23.10")).toBe("toCheck");
    expect(at("pinned in [[x]] on 2026-10-23")).toBe("toCheck");
    expect(at("see [[x]], PR #3538")).toBe("toCheck");
    expect(at("see [[x]], PR 2")).toBe("toCheck");
    expect(at("[[x]] runs 7 av 8 tests")).toBe("toCheck");
    expect(at("[[x]] holds the fixtures")).toBe("mentions");
    // A version, an anchor and a link destination are no claim.
    expect(at("[[x]] needs v1.2 and [[x#12]] and [doc](y.md#34)")).toBe("mentions");
    // Version numbers, decimals and measurements are no date (F2).
    for (const t of ["Opus 4.6", "CDM 4.4", "Bun 1.3", "Node 22.12", "section 4.2", "takes 2.5 min", "12.5 %", "v1.2", "1.2.3", "GPT‑5.6", "Python 3.10+", "in 9.5–10.6 min", "a 2.5k-char note", "Version 8.7", "phase 1.5"]) {
      expect([t, at(`[[x]] uses ${t}`)]).toEqual([t, "mentions"]);
    }
    for (const t of ["on 23.10", "den 4.6", "på 3.10", "(23.10)", "23.10.2026", "fra 1.11.", "2026-10-23", "Siden 03.10", "x. Fra 13.10 y"]) {
      expect([t, at(`[[x]] ${t}`)]).toEqual([t, "toCheck"]);
    }
    // A sentence-initial capitalised word keeps the date; an all-caps one does not.
    expect(at("Mandag 23.10: [[x]] got its pin")).toBe("toCheck");
    expect(at("CDM 4.4 rollout: [[x]] holds the toggle")).toBe("mentions");
    // A link is a word: a capitalised word right after one is mid-sentence.
    expect(at("[[x]] Opus 4.6 drafts it")).toBe("mentions");
    // A leading-zero day stays a date after a capitalised word mid-sentence.
    expect(at("[[x]] confirmed by Rune 08.10")).toBe("toCheck");
    // No linking passage left (all on exempt lines): a Mention.
    expect(bucketFor({ page, lastChangeMs: undefined, changedAtMs, passages: [] })).toBe("mentions");
  });
});

describe("parseStaleAsOf", () => {
  test("a day is its end, an instant is itself, digits are ms, junk is null", () => {
    expect(parseStaleAsOf("2026-10-25")).toBe(Date.parse("2026-10-25T23:59:59.999Z"));
    expect(parseStaleAsOf("2026-10-25T08:00:00Z")).toBe(Date.parse("2026-10-25T08:00:00Z"));
    expect(parseStaleAsOf("1793000000000")).toBe(1793000000000);
    expect(parseStaleAsOf(undefined)).toBeUndefined();
    expect(parseStaleAsOf("yesterday")).toBeNull();
    expect(parseStaleAsOf("2026-13-45")).toBeNull();
  });
});

// ── Against a real (temp, git-backed) index ────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.email=f@example.com", "-c", "user.name=f", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;

describe("the index, the buckets and Moved with on a temp wiki", () => {
  let root = "";
  let index: WikiIndex;
  const asOfMs = Date.parse("2026-06-20T23:59:59.999Z");

  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  const commitAt = async (iso: string, msg: string) => {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", iso, "-m", msg);
  };

  test("setup", async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-"));
    await git(root, "init", "-q", "-b", "main");
    // Old linking pages, one per bucket.
    await write("notes/claim.md", page("Claim", "The pin in [[hub]] landed on 23.05."));
    await write("notes/mention.md", page("Mention", "The fixtures live in [[hub]]."));
    await write("notes/pointer.md", page("Pointer", "Body.\n\n## See also\n\n- [[hub]] and its whole long description here"));
    await write("archive/old.md", page("Old", "[[hub]] was shipped on 01.05."));
    await write("notes/later.md", page("Later", "Draft of [[hub]]."));
    await write("plans/p.md", page("P", "Body.", "plan_status: shipped\n"));
    await write("plans/q.md", page("Q", "Body.", "plan_status: in-flight\n"));
    await write("hub.md", page("Hub", "- [[p]] is in-flight\n- [[q]] is in-flight\n- [[p]] ~~in-flight~~ shipped"));
    await commitAt("2026-05-01T10:00:00Z", "seed");
    // The changed page moves together with plans/q.md.
    await write("hub.md", page("Hub", "- [[p]] is in-flight\n- [[q]] is in-flight\n- [[p]] ~~in-flight~~ shipped\n\nMore."));
    await write("plans/q.md", page("Q", "Body two.", "plan_status: in-flight\n"));
    await write("index.md", page("Index", "- [[hub]]"));
    await commitAt("2026-06-18T10:00:00Z", "hub and q");
    // A linking page changed after the hub did.
    await write("notes/later.md", page("Later", "Draft of [[hub]], again."));
    await commitAt("2026-06-19T10:00:00Z", "later");
    index = await buildWikiIndex(root);
  }, 30_000);

  test("the build keeps the hits: a disagreeing status on a living page, struck text and agreeing ones pass", () => {
    const hits = index.statusLineHits?.get("hub.md") ?? [];
    expect(hits.map((h) => [h.line, h.target, h.said, h.now])).toEqual([[5, "plans/p.md", ["in-flight"], "shipped"]]);
    // The archive page says «shipped» of a non-plan link: no hit, and archive is not living anyway.
    expect(index.statusLineHits?.has("archive/old.md")).toBe(false);
  });

  test("lint check 24 reports the same hit, at info", async () => {
    const report = await lintWiki(index);
    const f = report.findings.filter((x) => x.check === "status-line");
    expect(f.map((x) => [x.relPath, x.line, x.severity])).toEqual([["hub.md", 5, "info"]]);
    expect(report.counts["status-line"]).toBe(1);
  });

  test("buckets for the changed page, as of a pinned day", async () => {
    const b = await linkingBuckets(index, "hub.md", { asOfMs });
    expect(b).not.toBeNull();
    expect(b!.changedAtMs).toBe(Date.parse("2026-06-18T10:00:00Z"));
    const by = Object.fromEntries(b!.linking.map((l) => [l.relPath, l.bucket]));
    expect(by).toEqual({
      "archive/old.md": "history",
      "notes/claim.md": "toCheck",
      "notes/later.md": "changedSince",
      "notes/mention.md": "mentions",
      "notes/pointer.md": "pointers",
    });
    expect(b!.counts).toEqual({ toCheck: 1, mentions: 1, pointers: 1, history: 1, changedSince: 1 });
    // Cached on the index: the same promise answers again.
    expect(linkingBuckets(index, "hub.md", { asOfMs })).toBe(linkingBuckets(index, "hub.md", { asOfMs }));
  });

  test("a reserved page is never a changed page", async () => {
    expect(await linkingBuckets(index, "index.md", { asOfMs })).toBeNull();
  });

  test("a page whose last change is over 14 days old gets no buckets", async () => {
    expect(await linkingBuckets(index, "notes/mention.md", { asOfMs })).toBeNull();
    // As of a later day, the hub is no longer a changed page either.
    expect(await linkingBuckets(index, "hub.md", { asOfMs: asOfMs + 20 * DAY })).toBeNull();
  });

  test("Moved with: the page committed with it, in the window only", () => {
    expect(movedWith(index, "hub.md", asOfMs).map((r) => [r.relPath, r.n])).toEqual([["plans/q.md", 1]]);
    // The seed commit touched 8 files — under the sweep threshold — but falls outside 28 days.
    expect(movedWith(index, "notes/mention.md", asOfMs)).toEqual([]);
  });

  test("the summary lists changed pages and pages with hits, with both counts", async () => {
    const s = await staleSummary(index, { asOfMs });
    const rows = Object.fromEntries(s.pages.map((p) => [p.relPath, [p.staleLines, p.toCheck, p.changed]]));
    expect(rows["hub.md"]).toEqual([1, 1, true]);
    expect(rows["notes/later.md"]).toEqual([0, 0, true]);
    expect(rows["notes/mention.md"]).toBeUndefined();
    expect(s.totals).toEqual({ staleLines: 1, toCheck: 1, changedPages: 3 });
    const r = await stalePageReport(index, index.resolveRelPath("hub.md")!, { asOfMs });
    expect(r.changed).toBe(true);
    expect(r.hits).toHaveLength(1);
    expect(r.movedWith.map((m) => m.relPath)).toEqual(["plans/q.md"]);
  });

  test("teardown", async () => {
    await rm(root, { recursive: true, force: true });
  });
});

describe("asOf steps back past metadata-only commits (D29, F3)", () => {
  let root = "";
  let index: WikiIndex;
  // The stamp commit (06-18) is inside 14 days of asOf; the last edit before it (06-01) is not.
  const asOfMs = Date.parse("2026-06-20T23:59:59.999Z");

  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  const commitAt = async (iso: string, msg: string) => {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", iso, "-m", msg);
  };

  test("setup", async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-asof-"));
    await git(root, "init", "-q", "-b", "main");
    await write("notes/a.md", page("A", "First text."));
    await write("notes/b.md", page("B", "Links [[a]]."));
    await commitAt("2026-05-01T10:00:00Z", "seed");
    await write("notes/a.md", page("A", "Edited text."));
    await commitAt("2026-06-01T10:00:00Z", "edit a");
    // Metadata only: a series and a prs stamp, body unchanged.
    await write("notes/a.md", page("A", "Edited text.", "series: s1\nprs: [12]\n"));
    await commitAt("2026-06-18T10:00:00Z", "stamp a");
    // A real edit after asOf, so the step-back runs.
    await write("notes/a.md", page("A", "Edited again.", "series: s1\nprs: [12]\n"));
    await commitAt("2026-06-25T10:00:00Z", "edit a again");
    index = await buildWikiIndex(root);
  }, 30_000);

  test("the stamp commit is no change: as of 06-20 the page last changed 06-01, so it is not changed", async () => {
    const a = index.resolveRelPath("notes/a.md")!;
    expect(a.gitTouchedMs).toBe(Date.parse("2026-06-25T10:00:00Z"));
    const r = await stalePageReport(index, a, { asOfMs });
    expect(r.lastChangeMs).toBe(Date.parse("2026-06-01T10:00:00Z"));
    expect(r.changed).toBe(false);
    expect(await linkingBuckets(index, "notes/a.md", { asOfMs })).toBeNull();
    // Without asOf the newest edit stands.
    expect((await stalePageReport(index, a)).lastChangeMs).toBe(Date.parse("2026-06-25T10:00:00Z"));
  });

  test("teardown", async () => {
    await rm(root, { recursive: true, force: true });
  });
});

describe("the summary's counts-only path (F6)", () => {
  let root = "";
  let index: WikiIndex;
  const asOfMs = Date.parse("2026-06-20T23:59:59.999Z");

  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  const commitAt = async (iso: string, msg: string) => {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", iso, "-m", msg);
  };

  test("setup", async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-counts-"));
    await git(root, "init", "-q", "-b", "main");
    // Older pages linking BOTH changed pages: one claim-bearing, one mention, one pointer.
    await write("notes/claim.md", page("Claim", "[[a]] landed on 23.05.\n\n[[b]] has 3 of 5 done."));
    await write("notes/mention.md", page("Mention", "See [[a]] and [[b]]."));
    await write("notes/pointer.md", page("Pointer", "Body.\n\n## See also\n\n- [[a]]\n- [[b]]"));
    // History, whatever its passages say.
    await write("archive/old.md", page("Old", "[[a]] was shipped on 01.05, [[b]] on 02.05."));
    await write("plans/done.md", page("Done", "[[a]] on 03.05.", "plan_status: shipped\n"));
    await write("notes/later.md", page("Later", "Draft of [[a]] and [[b]]."));
    await write("a.md", page("A", "Body."));
    await write("b.md", page("B", "Body."));
    await commitAt("2026-05-01T10:00:00Z", "seed");
    await write("a.md", page("A", "Body two."));
    await write("b.md", page("B", "Body two."));
    await commitAt("2026-06-12T10:00:00Z", "a and b");
    // A linking page changed after both did, and one inside the 2-day margin.
    await write("notes/later.md", page("Later", "Draft of [[a]] and [[b]], 12.06."));
    await commitAt("2026-06-19T10:00:00Z", "later");
    await write("notes/near.md", page("Near", "[[a]] on 11.06."));
    await commitAt("2026-06-11T10:00:00Z", "near");
    index = await buildWikiIndex(root);
  }, 30_000);

  test("it reads only the older, non-history linking pages, each once across changed pages", async () => {
    const reads: string[] = [];
    const readFile = async (abs: string) => {
      reads.push(path.relative(root, abs));
      return Bun.file(abs).text();
    };
    await staleSummary(index, { asOfMs, readFile });
    expect(reads.sort()).toEqual(["notes/claim.md", "notes/mention.md", "notes/pointer.md"]);
  });

  test("its counts are exactly the full path's, page by page", async () => {
    const s = await staleSummary(index, { asOfMs });
    const changed = s.pages.filter((p) => p.changed);
    expect(changed.map((p) => p.relPath).sort()).toEqual(["a.md", "b.md", "notes/later.md", "notes/near.md"]);
    for (const row of changed) {
      const full = await linkingBuckets(index, row.relPath, { asOfMs });
      expect([row.relPath, row.toCheck]).toEqual([row.relPath, full!.counts.toCheck]);
      // A readFile bypasses both caches, so these are the counts path's own.
      expect(await linkingCounts(index, row.relPath, { asOfMs, readFile: (a) => Bun.file(a).text() })).toEqual(full!.counts);
    }
    expect((await linkingBuckets(index, "a.md", { asOfMs }))!.counts).toEqual({ toCheck: 1, mentions: 2, pointers: 1, history: 2, changedSince: 1 });
  });

  test("teardown", async () => {
    await rm(root, { recursive: true, force: true });
  });
});
