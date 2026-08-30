import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, LINT_CHECKS, type LintFinding } from "./lint.ts";

/**
 * Lint-engine tests over temp-dir wiki fixtures (modeled on store.test.ts).
 * Each fixture is crafted so exactly one check fires where expected, and the
 * reserved files (index.md / log.md / CLAUDE.md) are exempt from the
 * frontmatter-shaped + orphan checks.
 */
describe("lintWiki", () => {
  let root: string;
  const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

  /**
   * The pinned "now" every lint run in this file is judged against. Deliberately AFTER
   * every fixture's `updated:` (2026-06-01…08): the future-date case below reads this
   * clock, so a `now` in the past — the old literal `1_700_000_000_000` (2023-11-14) —
   * would make every fixture page read as future-stamped.
   */
  const NOW = Date.parse("2026-06-20T12:00:00Z");

  async function lint(): Promise<LintFinding[]> {
    const index = await buildWikiIndex(root);
    const { findings } = await lintWiki(index, { now: () => NOW });
    return findings;
  }

  /** Findings of one check kind, as a set of relPaths (order-independent). */
  function relPathsFor(findings: LintFinding[], check: string): string[] {
    return findings.filter((f) => f.check === check).map((f) => f.relPath).sort();
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-lint-"));
    await mkdir(path.join(root, "concepts"), { recursive: true });
    await mkdir(path.join(root, "entities"), { recursive: true });
    await mkdir(path.join(root, "sources"), { recursive: true });

    // A well-formed concept page: linked-to, has updated:, has a ## Sources
    // heading, and links only to real pages. Should produce NO findings.
    await write(
      "concepts/Good Concept.md",
      [
        "---",
        "type: concept",
        "title: Good Concept",
        "updated: 2026-06-01",
        "---",
        "",
        "Links to [[Real Source]] and [[Sidekick]].",
        "",
        "## Sources",
        "- https://example.com/a",
      ].join("\n"),
    );

    // A source page that the good concept links to (keeps Good Concept non-broken
    // and gives Real Source an inbound link so it isn't an orphan).
    await write(
      "sources/Real Source.md",
      ["---", "type: source", "title: Real Source", "updated: 2026-06-02", "---", "", "Body."].join("\n"),
    );

    // Reserved files: index.md links everything, log.md is the activity log,
    // CLAUDE.md is instructions. None must be flagged for orphan / stale-updated.
    await write("index.md", "# Wiki Index\n\n- [[Good Concept]]\n- [[Sidekick]]");
    await write("log.md", "# Activity Log\n\n## [2026-06-01] create | Good Concept");
    await write("CLAUDE.md", "# Wiki rules\n\nNo frontmatter here.");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("clean wiki produces no findings", async () => {
    // "Sidekick" is referenced by Good Concept + index but doesn't exist yet →
    // that's a broken link. Add it so the baseline is genuinely clean.
    await write(
      "concepts/Sidekick.md",
      [
        "---",
        "type: concept",
        "title: Sidekick",
        "updated: 2026-06-03",
        "sources: [https://example.com/s]",
        "---",
        "",
        "Backed by [[Good Concept]].",
      ].join("\n"),
    );
    const findings = await lint();
    expect(findings).toEqual([]);
  });

  test("broken wikilink fires broken-link with the raw target", async () => {
    // Good Concept references [[Sidekick]] which doesn't exist.
    const findings = await lint();
    const broken = findings.filter((f) => f.check === "broken-link");
    // Good Concept: [[Sidekick]] unresolved; index.md: [[Sidekick]] unresolved.
    const messages = broken.map((f) => f.message);
    expect(messages).toContain("Unresolved wikilink [[Sidekick]]");
    expect(broken.some((f) => f.relPath === "concepts/Good Concept.md")).toBe(true);
    // A broken finding carries the raw target text.
    expect(broken.every((f) => f.detail === "wikilink" || f.detail === "markdown")).toBe(true);
  });

  test("broken relative markdown link fires broken-link", async () => {
    await write(
      "concepts/Sidekick.md",
      ["---", "type: concept", "title: Sidekick", "updated: 2026-06-03", "sources: [x]", "---", "", "See [gone](./Nope.md)."].join("\n"),
    );
    const findings = await lint();
    const broken = findings.filter(
      (f) => f.check === "broken-link" && f.relPath === "concepts/Sidekick.md",
    );
    expect(broken.length).toBe(1);
    expect(broken[0]!.message).toContain("Nope.md");
    expect(broken[0]!.detail).toBe("markdown");
  });

  test("relative .html explainer links never fire broken-link (real, missing, or shadowed)", async () => {
    await mkdir(path.join(root, "blogs"), { recursive: true });
    // A real explainer (indexed) and a shadowed one (same-stem .md wins, dropped
    // from the index but present on disk).
    await write("blogs/deep-dive.html", "<title>Deep Dive</title>");
    await write("blogs/genesis.html", "<title>Genesis mirror</title>");
    await write("concepts/Genesis.md", "---\ntype: concept\ntitle: Genesis\nupdated: 2026-06-03\nsources: [x]\n---\n\nCanonical.");
    await write(
      "concepts/Sidekick.md",
      [
        "---",
        "type: concept",
        "title: Sidekick",
        "updated: 2026-06-03",
        "sources: [x]",
        "---",
        "",
        "Real explainer [a](../blogs/deep-dive.html).",
        "Shadowed explainer [b](../blogs/genesis.html).",
        "Missing explainer [c](../blogs/nope.html).",
      ].join("\n"),
    );
    const findings = await lint();
    // NONE of the three .html links produces a broken-link finding: resolving to
    // a real explainer is valid, and unresolved .html (missing or shadowed) is
    // deliberately exempt so the linter watcher sees no spurious jump.
    const broken = findings.filter(
      (f) => f.check === "broken-link" && f.relPath === "concepts/Sidekick.md",
    );
    expect(broken).toEqual([]);
  });

  test("[[Page#Section]] to an existing page is not broken; the linked page is not an orphan", async () => {
    await write(
      "concepts/Sidekick.md",
      [
        "---",
        "type: concept",
        "title: Sidekick",
        "updated: 2026-06-03",
        "sources: [x]",
        "---",
        "",
        "Deep link to [[Good Concept#Sources]] and a self-anchor [[#top]].",
      ].join("\n"),
    );
    const findings = await lint();
    // Neither the anchor form nor the bare self-anchor is a broken link.
    expect(relPathsFor(findings, "broken-link")).not.toContain("concepts/Sidekick.md");
    // Good Concept's only real inbound link is the anchor one — still not an orphan.
    expect(relPathsFor(findings, "orphan")).not.toContain("concepts/Good Concept.md");
  });

  test("literal [[wikilinks]] inside code fences and inline code are not broken links", async () => {
    await write(
      "concepts/Sidekick.md",
      [
        "---",
        "type: concept",
        "title: Sidekick",
        "updated: 2026-06-03",
        "sources: [x]",
        "---",
        "",
        "Real link: [[Good Concept]].",
        "",
        "```",
        "Use [[Some Fake Page]] syntax like this.",
        "```",
        "",
        "Inline meta-mention: `[[Another Fake]]` stays code.",
      ].join("\n"),
    );
    const findings = await lint();
    const broken = findings.filter(
      (f) => f.check === "broken-link" && f.relPath === "concepts/Sidekick.md",
    );
    expect(broken).toEqual([]);
  });

  test("orphan page fires orphan; index/log-only linkers don't rescue it", async () => {
    // An orphan concept nobody links to except index.md (which is discounted).
    await write(
      "concepts/Lonely.md",
      ["---", "type: concept", "title: Lonely", "updated: 2026-06-04", "sources: [x]", "---", "", "Alone."].join("\n"),
    );
    await write("index.md", "# Wiki Index\n\n- [[Good Concept]]\n- [[Sidekick]]\n- [[Lonely]]");
    // Also add Sidekick so the only orphan under test is Lonely (+ existing ones).
    await write(
      "concepts/Sidekick.md",
      ["---", "type: concept", "title: Sidekick", "updated: 2026-06-05", "sources: [x]", "---", "", "Backed by [[Good Concept]]."].join("\n"),
    );
    const findings = await lint();
    const orphans = relPathsFor(findings, "orphan");
    // Lonely is linked only by index.md (discounted) → orphan.
    expect(orphans).toContain("concepts/Lonely.md");
    // Reserved files are never orphan subjects.
    expect(orphans).not.toContain("index.md");
    expect(orphans).not.toContain("log.md");
    expect(orphans).not.toContain("CLAUDE.md");
    // Good Concept has a real inbound link (Sidekick) → not an orphan.
    expect(orphans).not.toContain("concepts/Good Concept.md");
  });

  test("missing / unparseable updated: fires stale-updated; reserved files exempt", async () => {
    await write(
      "concepts/No Updated.md",
      ["---", "type: concept", "title: No Updated", "sources: [x]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    await write(
      "concepts/Bad Updated.md",
      ["---", "type: concept", "title: Bad Updated", "updated: not-a-date", "sources: [x]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    const findings = await lint();
    const stale = relPathsFor(findings, "stale-updated");
    expect(stale).toContain("concepts/No Updated.md");
    expect(stale).toContain("concepts/Bad Updated.md");
    // CLAUDE.md has no frontmatter but is reserved → never flagged for updated.
    expect(stale).not.toContain("CLAUDE.md");
    expect(stale).not.toContain("index.md");
    // Good Concept has a valid updated: → not flagged.
    expect(stale).not.toContain("concepts/Good Concept.md");
  });

  test("a frontmatter date implausibly in the future fires stale-updated", async () => {
    // The reader's recency sorts IGNORE such a stamp (`isImplausibleFutureDate`), which
    // is right for the ordering but leaves the bad stamp with no operator-visible signal
    // anywhere. This check is that signal. NOW is 2026-06-20T12:00Z, so +60h is past the
    // 48h skew allowance and +36h is inside it.
    await write(
      "concepts/Future Updated.md",
      ["---", "type: concept", "title: Future Updated", "updated: 2026-06-23", "sources: [x]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    await write(
      "concepts/Future Created.md",
      ["---", "type: concept", "title: Future Created", "updated: 2026-06-10", "created: 2026-06-23", "sources: [x]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    // Inside the skew allowance (a plain day authored in UTC+14, a slightly skewed
    // clock) — trusted by the sort, so never flagged here either.
    await write(
      "concepts/Nearly Now.md",
      ["---", "type: concept", "title: Nearly Now", "updated: 2026-06-22", "sources: [x]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    const findings = await lint();
    const stale = relPathsFor(findings, "stale-updated");
    expect(stale).toContain("concepts/Future Updated.md");
    expect(stale).toContain("concepts/Future Created.md");
    expect(stale).not.toContain("concepts/Nearly Now.md");
    // Past-dated fixtures are untouched — no existing wiki starts reporting findings.
    expect(stale).not.toContain("concepts/Good Concept.md");
    expect(stale).not.toContain("sources/Real Source.md");

    // The message names the offending FIELD and value, so the gate list is actionable.
    const updatedFinding = findings.find(
      (f) => f.check === "stale-updated" && f.relPath === "concepts/Future Updated.md",
    )!;
    expect(updatedFinding.message).toContain("updated:");
    expect(updatedFinding.message).toContain("2026-06-23");
    expect(updatedFinding.detail).toContain("48h");
    const createdFinding = findings.find(
      (f) => f.check === "stale-updated" && f.relPath === "concepts/Future Created.md",
    )!;
    expect(createdFinding.message).toContain("created:");
  });

  test("an unparseable updated: is reported as such, and never as a future date", async () => {
    // The `updated` field itself reports ONE way: unparseable, not future — an
    // unparseable value has no instant to compare.
    await write(
      "concepts/Bad Updated.md",
      ["---", "type: concept", "title: Bad Updated", "updated: not-a-date", "sources: [x]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    const findings = await lint();
    const mine = findings.filter(
      (f) => f.check === "stale-updated" && f.relPath === "concepts/Bad Updated.md",
    );
    expect(mine.length).toBe(1);
    expect(mine[0]!.message).toContain("Unparseable");
    expect(mine[0]!.message).not.toContain("future");
  });

  test("a future created: is reported even when updated: is missing or unparseable", async () => {
    // The two fields feed two different sorts, so the checks are independent. The
    // pre-fix code returned early on the missing/unparseable `updated` branches, which
    // hid the WORSE finding behind the milder one: a page whose `created: 2027-…`
    // silently corrupts "Recently added" reported only "Missing frontmatter: updated:".
    await write(
      "concepts/No Updated Future Created.md",
      ["---", "type: concept", "title: No Updated Future Created", "created: 2026-06-23", "sources: [x]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    await write(
      "concepts/Bad Updated Future Created.md",
      ["---", "type: concept", "title: Bad Updated Future Created", "updated: not-a-date", "created: 2026-06-23", "sources: [x]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    const findings = await lint();

    const missing = findings.filter(
      (f) => f.check === "stale-updated" && f.relPath === "concepts/No Updated Future Created.md",
    );
    expect(missing.length).toBe(2);
    expect(missing.map((f) => f.message).join(" | ")).toContain("Missing frontmatter: updated:");
    expect(missing.some((f) => /created: "2026-06-23" is in the future/.test(f.message))).toBe(true);

    const unparseable = findings.filter(
      (f) => f.check === "stale-updated" && f.relPath === "concepts/Bad Updated Future Created.md",
    );
    expect(unparseable.length).toBe(2);
    expect(unparseable.some((f) => /Unparseable updated/.test(f.message))).toBe(true);
    expect(unparseable.some((f) => /created: "2026-06-23" is in the future/.test(f.message))).toBe(true);

    // A missing/unparseable `updated` with a SOUND `created` still reports only the
    // one finding — the created check adds nothing when there is nothing wrong.
    await write(
      "concepts/No Updated Sound Created.md",
      ["---", "type: concept", "title: No Updated Sound Created", "created: 2026-06-01", "sources: [x]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    const again = await lint();
    expect(
      again.filter(
        (f) => f.check === "stale-updated" && f.relPath === "concepts/No Updated Sound Created.md",
      ).length,
    ).toBe(1);
  });

  test("concept without sources fires missing-sources; entity + sourced concept exempt", async () => {
    await write(
      "concepts/Sourceless.md",
      ["---", "type: concept", "title: Sourceless", "updated: 2026-06-06", "---", "", "Linked [[Good Concept]]. No sources anywhere."].join("\n"),
    );
    // An entity stub with no sources — must NOT fire (out of scope).
    await write(
      "entities/Some Person.md",
      ["---", "type: entity", "title: Some Person", "updated: 2026-06-07", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    // A concept that cites via frontmatter sources: instead of a heading — exempt.
    await write(
      "concepts/FM Sourced.md",
      ["---", "type: concept", "title: FM Sourced", "updated: 2026-06-08", "sources: [https://example.com/z]", "---", "", "Linked [[Good Concept]]."].join("\n"),
    );
    const findings = await lint();
    const missing = relPathsFor(findings, "missing-sources");
    expect(missing).toContain("concepts/Sourceless.md");
    expect(missing).not.toContain("entities/Some Person.md");
    expect(missing).not.toContain("concepts/FM Sourced.md");
    // Good Concept has a ## Sources heading → exempt.
    expect(missing).not.toContain("concepts/Good Concept.md");
  });

  // ── index-truncation ───────────────────────────────────────────────────────

  test("a line whose [[ never closes is reported, with its line number", async () => {
    await write(
      "index.md",
      [
        "# Wiki Index",
        "",
        "- [[Good Concept]] — a summary that was cut mid-link at [[Some Long Page",
        "- [[Sidekick]] — fine.",
      ].join("\n"),
    );
    const findings = await lint();
    const truncation = findings.filter((f) => f.check === "index-truncation");
    expect(truncation.map((f) => f.relPath)).toEqual(["index.md"]);
    expect(truncation[0]!.message).toContain("line 3");
    expect(truncation[0]!.message).toContain("[[Some Long Page");
  });

  test("an EARLIER dangling [[ is reported even when a later one closes", async () => {
    // The `lastIndexOf` predicate this replaced saw only `[[Beta]]`, found its
    // `]]`, and reported nothing — while `[[Frag and later [[Beta` is exactly the
    // phantom target that hides the real `[[Beta]]` link.
    await write(
      "index.md",
      ["# Wiki Index", "", "- [[A]] — earlier unclosed [[Frag and later [[Beta]] end"].join("\n"),
    );
    const truncation = (await lint()).filter((f) => f.check === "index-truncation");
    expect(truncation.map((f) => f.relPath)).toEqual(["index.md"]);
    expect(truncation[0]!.message).toContain("[[Frag and later [[Beta]] end");
  });

  test("the excerpt is quoted from the RAW line, so the finding greps", async () => {
    const line = "- [[Good Concept]] — see `the [[x]] form` then [[Truncated Here";
    await write("index.md", ["# Wiki Index", "", line].join("\n"));
    const truncation = (await lint()).filter((f) => f.check === "index-truncation");
    expect(truncation).toHaveLength(1);
    // The quoted excerpt appears VERBATIM in the file, code span included.
    const msg = truncation[0]!.message;
    const excerpt = msg.slice(msg.lastIndexOf("(") + 1, -1);
    expect(excerpt).toBe("[[Truncated Here");
    expect(line).toContain(excerpt);
  });

  test("a mixed ``` / ~~~ pair does not close, and a nested fence stays inside", async () => {
    await write(
      "index.md",
      [
        "# Wiki Index",
        "",
        "````md", // 4-backtick outer fence
        "```", // inner 3-backtick run — NOT a closer of a 4-run opener
        "- [[Documented dangling",
        "```",
        "````",
        "",
        "```",
        "~~~", // a tilde line never closes a backtick fence
        "- [[Also documented",
        "```",
      ].join("\n"),
    );
    expect(relPathsFor(await lint(), "index-truncation")).toEqual([]);
  });

  test("a prose line carrying an inline code span does not disarm the rest of the file", async () => {
    // The naive `/^\s*(```|~~~)/` toggle treated this line as a fence OPENER,
    // masking every line after it — a silent false NEGATIVE over the whole page.
    await write(
      "index.md",
      [
        "# Wiki Index",
        "",
        "```bash``` is how you fence a shell block.",
        "",
        "- [[Really truncated here",
      ].join("\n"),
    );
    const truncation = (await lint()).filter((f) => f.check === "index-truncation");
    expect(truncation).toHaveLength(1);
    expect(truncation[0]!.message).toContain("[[Really truncated here");
  });

  test("YAML frontmatter is not markdown and is never flagged", async () => {
    await write(
      "concepts/Good Concept.md",
      [
        "---",
        "type: concept",
        "title: 'A [[weird title'",
        "updated: 2026-06-01",
        "---",
        "",
        "Links to [[Real Source]].",
        "",
        "## Sources",
        "- https://example.com/a",
      ].join("\n"),
    );
    expect(relPathsFor(await lint(), "index-truncation")).toEqual([]);
  });

  test("a double-backtick code span is paired by run length, not by the next backtick", async () => {
    await write(
      "index.md",
      ["# Wiki Index", "", "- [[Good Concept]] — write a literal as `` [[x` `` in prose."].join("\n"),
    );
    expect(relPathsFor(await lint(), "index-truncation")).toEqual([]);
  });

  test("an MDX/JSX array prop opener is exempt, and only that shape", async () => {
    await write(
      "index.md",
      [
        "# Wiki Index",
        "",
        "<ComparisonTable rows={[[",
        '  ["a", "b"],',
        "]} />",
      ].join("\n"),
    );
    expect(relPathsFor(await lint(), "index-truncation")).toEqual([]);

    await write("index.md", ["# Wiki Index", "", "prose { [[Not a JSX opener"].join("\n"));
    expect(relPathsFor(await lint(), "index-truncation")).toEqual(["index.md"]);
  });

  test("balanced lines, fenced blocks and inline code never fire", async () => {
    await write(
      "concepts/Good Concept.md",
      [
        "---",
        "type: concept",
        "title: Good Concept",
        "updated: 2026-06-01",
        "---",
        "",
        "Links to [[Real Source]] and [[Sidekick|the sidekick]].",
        "",
        "A meta-mention of `[[an unclosed one` in a code span.",
        "",
        "```md",
        "[[Docs about wikilink syntax",
        "```",
        "",
        "## Sources",
        "- https://example.com/a",
      ].join("\n"),
    );
    const findings = await lint();
    expect(relPathsFor(findings, "index-truncation")).toEqual([]);
  });

  // ── nested-annotation ──────────────────────────────────────────────────────

  test("a `<Fact>` mark inside a wikilink's brackets is reported", async () => {
    await write(
      "concepts/Good Concept.md",
      [
        "---",
        "type: concept",
        "title: Good Concept",
        "updated: 2026-06-01",
        "---",
        "",
        'Send [[<Fact n="4" v="ok">Real Source</Fact>]] to the slow queue.',
        "",
        "## Sources",
        "- https://example.com/a",
      ].join("\n"),
    );
    const findings = (await lint()).filter((f) => f.check === "nested-annotation");
    expect(findings.map((f) => f.relPath)).toEqual(["concepts/Good Concept.md"]);
    // The excerpt is quoted from the raw line, so the finding can be grepped.
    expect(findings[0]!.message).toContain("line 7");
    expect(findings[0]!.message).toContain('[[<Fact n="4" v="ok">Real Source');
  });

  test("the correct nesting — the mark AROUND the link — is clean", async () => {
    await write(
      "concepts/Good Concept.md",
      [
        "---",
        "type: concept",
        "title: Good Concept",
        "updated: 2026-06-01",
        "---",
        "",
        'Send <Fact n="4" v="ok">[[Real Source]]</Fact> to the slow queue.',
        "",
        "## Sources",
        "- https://example.com/a",
      ].join("\n"),
    );
    expect(relPathsFor(await lint(), "nested-annotation")).toEqual([]);
  });

  test("fenced, inline-code and frontmatter occurrences are documentation", async () => {
    // The shape a page documenting this very defect carries — mimir's own plan
    // quotes it in a ```markdown fence and again in backticks.
    await write(
      "index.md",
      [
        "---",
        'title: \'Broken: [[<Fact n="1" v="ok">x</Fact>]]\'',
        "---",
        "",
        "# Wiki Index",
        "",
        "```markdown",
        '- [[<Fact n="4" v="ok">A Page</Fact>]]-class engines',
        "```",
        "",
        'The broken shape is `[[<Fact n="4" v="ok">A Page</Fact>]]` — do not ship it.',
      ].join("\n"),
    );
    expect(relPathsFor(await lint(), "nested-annotation")).toEqual([]);
  });

  test("REPRO: on a MIXED line the excerpt quotes the live occurrence, not the coded one", async () => {
    // `raw.search(...)` found the BACKTICKED documentation occurrence — the finding
    // pointed the reader at the one thing on the line that is not the defect.
    await write(
      "index.md",
      [
        "# Wiki Index",
        "",
        'Coded: `[[<Fact n="2" v="ok">Doc Page</Fact>]]` — and live: [[<Fact n="1" v="bad">Real Page</Fact>]] here.',
      ].join("\n"),
    );
    const findings = (await lint()).filter((f) => f.check === "nested-annotation");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('[[<Fact n="1" v="bad">Real Page');
    expect(findings[0]!.message).not.toContain("Doc Page");
  });

  test("an MDX/JSX array opener is not a wikilink", async () => {
    // `rows={[[<Verdict …` is mimir house style — the same exclusion
    // `index-truncation` already carries, through the same shared mask.
    await write(
      "index.md",
      ["# Wiki Index", "", '<ComparisonTable rows={[[<Verdict v="ok" />, "yes"]]} />'].join("\n"),
    );
    expect(relPathsFor(await lint(), "nested-annotation")).toEqual([]);
  });

  test("a lowercase placeholder in brackets is prose, not markup", async () => {
    // `[[<raw YouTube title>]]` is a naming convention the jarvis wiki's log.md
    // describes; a `<[A-Za-z]` class would report it three times over.
    await write("index.md", ["# Wiki Index", "", "The old convention was [[<raw title>]]."].join("\n"));
    expect(relPathsFor(await lint(), "nested-annotation")).toEqual([]);
  });

  test("counts summarize findings per check", async () => {
    const index = await buildWikiIndex(root);
    const report = await lintWiki(index);
    // Iterate the engine's own list — a new check must appear in `counts` too.
    for (const key of LINT_CHECKS) {
      expect(typeof report.counts[key]).toBe("number");
    }
    const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(report.findings.length);
    expect(typeof report.generatedAt).toBe("number");
  });
});

/**
 * `stem-collision` — the continuous regression guard behind the apply path's
 * approve-time refusal. Its own describe because every fixture here is a PAIR of
 * files, and the shape it reports is one the shared fixture wiki deliberately
 * has none of.
 */
describe("lintWiki — stem-collision", () => {
  let root: string;
  const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);
  const md = (title: string, type: string) =>
    `---\ntype: ${type}\ntitle: ${title}\nupdated: 2026-06-01\n---\n\n# ${title}\n\nBody.\n`;

  async function stemFindings(): Promise<LintFinding[]> {
    const index = await buildWikiIndex(root);
    const { findings } = await lintWiki(index, { now: () => Date.parse("2026-06-20T12:00:00Z") });
    return findings.filter((f) => f.check === "stem-collision");
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-lint-stem-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("cross-extension twin is reported, filed against the SHADOWED page", async () => {
    // The measured 2026-08-29 shape: a source page drafted as .mdx, an entity page
    // applied as .md. `.md` wins, so the .mdx is dropped from the index entirely.
    await write("sources/Aurora Ledger Protocol.mdx", md("Aurora Ledger Protocol", "source"));
    await write("entities/Aurora Ledger Protocol.md", md("Aurora Ledger Protocol", "entity"));

    const found = await stemFindings();
    expect(found.length).toBe(1);
    expect(found[0]!.relPath).toBe("sources/Aurora Ledger Protocol.mdx");
    expect(found[0]!.detail).toBe("entities/Aurora Ledger Protocol.md");
    expect(found[0]!.message).toContain("Aurora Ledger Protocol");
  });

  test("SAME-extension twins in two folders are NOT reported (a supported shape)", async () => {
    // `store.ts` keeps both and disambiguates them with a displayTitle prefix, so
    // neither is in `index.shadowed` at all. Counts per root live in
    // `src/watchers/CLAUDE.md`; the write-side guard allows the same shape.
    await write("concepts/Shared Stem.md", md("Shared Stem", "concept"));
    await write("entities/Shared Stem.md", md("Shared Stem", "entity"));
    expect(await stemFindings()).toEqual([]);
  });

  test("reserved infrastructure basenames are exempt", async () => {
    await write("index.md", "# Index\n");
    await write("notes/index.mdx", "---\ntitle: Index\n---\n\n# Index\n");
    expect(await stemFindings()).toEqual([]);
  });

  test("a shadowed .html EXPLAINER is NOT reported (markdown-vs-markdown only)", async () => {
    // The one place this check's scope DIVERGES from the write guard, which does
    // count `.html`: the guard refuses a write that would create a shadow, this
    // reports shadows that already exist — and every live instance (11 groups over
    // the six real roots, measured 2026-08-30) is a pre-existing pair a human kept.
    // Reporting them would ship this check permanently red on three of six wikis.
    await write("blogs/Aurora Ledger Protocol.md", md("Aurora Ledger Protocol", "note"));
    // Deliberately NOT carrying a `generated from` marker: the live pairs are
    // hand-authored explainers, not compile output — the exclusion holds either way.
    await write("blogs/Aurora Ledger Protocol.html", "<html><body>x</body></html>");
    expect(await stemFindings()).toEqual([]);
  });

  test("only the SHADOWED page's extension is tested — the winner's is implied", async () => {
    // A markdown loser can only ever have been displaced by an `.md` (the winner
    // won on a strictly lower `extRank`), so testing `shadowedBy` too was an
    // unreachable clause. Pinning the reachable half: a `.mdx` loser under a `.md`
    // winner IS reported, and no fixture can produce a markdown loser under an
    // `.html` winner.
    await write("concepts/Only Md Wins.md", md("Only Md Wins", "concept"));
    await write("sources/Only Md Wins.mdx", md("Only Md Wins", "source"));
    await write("blogs/Only Md Wins.html", "<html><body>x</body></html>");
    const found = await stemFindings();
    expect(found.map((f) => f.relPath)).toEqual(["sources/Only Md Wins.mdx"]);
    expect(found[0]!.detail).toBe("concepts/Only Md Wins.md");
  });

  test("a clean wiki reports nothing", async () => {
    await write("concepts/One.md", md("One", "concept"));
    await write("sources/Two.mdx", md("Two", "source"));
    expect(await stemFindings()).toEqual([]);
  });

  test("the check key is in LINT_CHECKS, so counts always carry it", async () => {
    await write("concepts/One.md", md("One", "concept"));
    const index = await buildWikiIndex(root);
    const { counts } = await lintWiki(index);
    expect(LINT_CHECKS).toContain("stem-collision");
    expect(counts["stem-collision"]).toBe(0);
  });
});
