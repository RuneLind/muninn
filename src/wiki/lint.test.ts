import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";

/**
 * Lint-engine tests over temp-dir wiki fixtures (modeled on store.test.ts).
 * Each fixture is crafted so exactly one check fires where expected, and the
 * reserved files (index.md / log.md / CLAUDE.md) are exempt from the
 * frontmatter-shaped + orphan checks.
 */
describe("lintWiki", () => {
  let root: string;
  const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

  async function lint(): Promise<LintFinding[]> {
    const index = await buildWikiIndex(root);
    const { findings } = await lintWiki(index, { now: () => 1_700_000_000_000 });
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

  test("counts summarize findings per check", async () => {
    const index = await buildWikiIndex(root);
    const report = await lintWiki(index);
    for (const key of ["broken-link", "orphan", "stale-updated", "missing-sources"]) {
      expect(typeof report.counts[key]).toBe("number");
    }
    const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(report.findings.length);
    expect(typeof report.generatedAt).toBe("number");
  });
});
