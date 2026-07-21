import { test, expect, describe } from "bun:test";
import {
  draftSourcePage,
  sourceTopicKey,
  sourceWikilinkTargets,
  buildSourceDraftPrompt,
  MIN_SOURCE_BODY_CHARS,
  type DraftSourcePageDeps,
  type SourceDraftInput,
} from "./source-drafter.ts";
import type { WikiIndex, WikiPageMeta } from "../wiki/store.ts";
import type { WikiRefs } from "../wiki/ingest-backlog.ts";
import type { InsertWikiProposalParams, WikiProposal } from "../db/wiki-proposals.ts";

const page = (over: Partial<WikiPageMeta>): WikiPageMeta => ({
  name: "x",
  title: "X",
  type: "concept",
  domain: "ai",
  tags: [],
  aliases: [],
  relPath: "concepts/x.md",
  ...over,
});

/** A fake index that resolves a fixed set of titles → pages (by title, case-insensitive). */
function fakeIndex(pages: WikiPageMeta[]): WikiIndex {
  const byTitle = new Map(pages.map((p) => [p.title.toLowerCase(), p]));
  const byRel = new Map(pages.map((p) => [p.relPath.toLowerCase(), p]));
  return {
    pages,
    outgoing: new Map(),
    backlinks: new Map(),
    resolve: (t: string) => byTitle.get(t.trim().toLowerCase()),
    resolveRelPath: (r: string) => byRel.get(r.toLowerCase()),
    scannedAt: 0,
    root: "/tmp/wiki",
  };
}

const SOURCE_URL = "https://youtu.be/abc12345678";

function mdxDraft(over: { type?: string; title?: string; body?: string } = {}): string {
  const type = over.type ?? "source";
  const title = over.title ?? "Retrieval-Augmented Generation";
  const body =
    over.body ??
    "# Retrieval-Augmented Generation\n\nRAG pairs retrieval with generation. See [[Model Context Protocol]].\n\n## See also\n- [[Model Context Protocol]]";
  return `---\ntype: ${type}\ntitle: ${title}\naliases: [RAG]\ncreated: 2026-07-19\nupdated: 2026-07-19\ntags: [rag]\nurl: ${SOURCE_URL}\nsources: [${SOURCE_URL}]\n---\n\n${body}`;
}

const emptyRefs: WikiRefs = { urls: new Set(), idTokens: new Set() };

/** A summary body comfortably over MIN_SOURCE_BODY_CHARS (400) so the thin-body
 *  guard is a no-op for the shared happy-path fixtures. */
const BODY_OVER_THRESHOLD =
  "Retrieval-Augmented Generation (RAG) pairs a retriever with a generator so a language model can ground its answers in an external corpus instead of relying solely on parametric memory. This explainer walks through embedding the query, searching a vector index, re-ranking the candidate passages, and conditioning the generation on the retrieved context, then discusses failure modes such as weak matches and hallucinated citations and how corrective retrieval mitigates them.";

function baseDeps(over: Partial<DraftSourcePageDeps> = {}): DraftSourcePageDeps {
  const input: SourceDraftInput = {
    collection: "youtube-summaries",
    docId: "abc12345678",
    url: SOURCE_URL,
    // Above MIN_SOURCE_BODY_CHARS (400) so the thin-body guard doesn't skip the
    // shared happy-path fixtures — the guard boundary is tested explicitly below.
    body: BODY_OVER_THRESHOLD,
  };
  const inserted: WikiProposal[] = [];
  return {
    botName: "jarvis",
    wikiDir: "/tmp/wiki",
    input,
    index: fakeIndex([
      page({ title: "Model Context Protocol", name: "Model Context Protocol", relPath: "concepts/Model Context Protocol.md" }),
    ]),
    today: "2026-07-19",
    callDrafter: async () => mdxDraft(),
    collectWikiRefs: async () => emptyRefs,
    liveTopicKeys: async () => [],
    liveSourceDocUrls: async () => [],
    insertProposal: async (params: InsertWikiProposalParams) => {
      const row = { id: `row-${inserted.length}`, ...params } as unknown as WikiProposal;
      inserted.push(row);
      return row;
    },
    ...over,
  };
}

describe("sourceTopicKey", () => {
  test("distinct namespace so it can't collide with a concept slug", () => {
    expect(sourceTopicKey("youtube-summaries", "abc")).toBe("source:youtube-summaries:abc");
  });
});

describe("sourceWikilinkTargets", () => {
  test("includes concept/entity/source pages with alias annotation, excludes other types", () => {
    const idx = fakeIndex([
      page({ title: "RAG", type: "concept", aliases: ["Retrieval-Augmented Generation"] }),
      page({ title: "Anthropic", type: "entity" }),
      page({ title: "Some Video", type: "source" }),
      page({ title: "A Note", type: "note" }),
    ]);
    const lines = sourceWikilinkTargets(idx);
    expect(lines).toContain("RAG (aliases: Retrieval-Augmented Generation)");
    expect(lines).toContain("Anthropic");
    expect(lines).toContain("Some Video");
    expect(lines).not.toContain("A Note");
  });

  test("null index → empty list", () => {
    expect(sourceWikilinkTargets(null)).toEqual([]);
  });
});

describe("buildSourceDraftPrompt", () => {
  test("carries the url, existing pages, and delimits the summary as untrusted", () => {
    const prompt = buildSourceDraftPrompt({
      input: baseDeps().input,
      today: "2026-07-19",
      existingPages: ["Model Context Protocol"],
    });
    expect(prompt).toContain(SOURCE_URL);
    expect(prompt).toContain("Model Context Protocol");
    expect(prompt).toContain("BEGIN SOURCE SUMMARY");
    expect(prompt).toContain('"type:" MUST be exactly "source"');
  });
});

describe("draftSourcePage", () => {
  test("happy path → drafted proposal at sources/<stem>.mdx, kind source, distinct topic_key", async () => {
    let captured: InsertWikiProposalParams | null = null;
    const deps = baseDeps({
      insertProposal: async (params) => {
        captured = params;
        return { id: "row-1", ...params } as unknown as WikiProposal;
      },
    });
    const out = await draftSourcePage(deps);
    expect(out.outcome).toBe("drafted");
    if (out.outcome !== "drafted") throw new Error("expected drafted");
    expect(out.targetPath).toBe("sources/Retrieval-Augmented Generation.mdx");
    expect(out.title).toBe("Retrieval-Augmented Generation");

    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe("source");
    expect(captured!.mode).toBe("create");
    expect(captured!.topicKey).toBe("source:youtube-summaries:abc12345678");
    expect(captured!.targetPath).toBe("sources/Retrieval-Augmented Generation.mdx");
    // The resolvable body wikilink SURVIVES containment (still a live link).
    expect(captured!.draft).toContain("[[Model Context Protocol]]");
    // source_docs carries the real doc + url; relatedPages is [] (not null legacy).
    expect(captured!.sourceDocs[0]).toMatchObject({ collection: "youtube-summaries", docId: "abc12345678", url: SOURCE_URL });
    expect(captured!.relatedPages).toEqual([]);
  });

  test("covered by URL already in the wiki → credit + skip (no draft call, no insert)", async () => {
    let drafted = false;
    let inserted = false;
    const out = await draftSourcePage(
      baseDeps({
        collectWikiRefs: async () => ({ urls: new Set([SOURCE_URL]), idTokens: new Set() }),
        callDrafter: async () => {
          drafted = true;
          return mdxDraft();
        },
        insertProposal: async (p) => {
          inserted = true;
          return { id: "x", ...p } as unknown as WikiProposal;
        },
      }),
    );
    expect(out.outcome).toBe("covered");
    expect(drafted).toBe(false);
    expect(inserted).toBe(false);
  });

  test("covered by a live source proposal (topic_key already live) → skip", async () => {
    const out = await draftSourcePage(
      baseDeps({ liveTopicKeys: async () => ["source:youtube-summaries:abc12345678"] }),
    );
    expect(out.outcome).toBe("covered");
  });

  test("stem collides with an existing .md page → skipped (reader precedence would shadow the .mdx)", async () => {
    const out = await draftSourcePage(
      baseDeps({
        index: fakeIndex([
          page({
            title: "Retrieval-Augmented Generation",
            name: "Retrieval-Augmented Generation",
            relPath: "sources/Retrieval-Augmented Generation.md",
          }),
        ]),
      }),
    );
    expect(out.outcome).toBe("skipped");
    if (out.outcome === "skipped") expect(out.reason).toContain("collides");
  });

  test("draft whose frontmatter type isn't source → shape gate skip", async () => {
    const out = await draftSourcePage(baseDeps({ callDrafter: async () => mdxDraft({ type: "concept" }) }));
    expect(out.outcome).toBe("skipped");
  });

  test("draft with no frontmatter title → skipped", async () => {
    const out = await draftSourcePage(baseDeps({ callDrafter: async () => "not a draft at all" }));
    expect(out.outcome).toBe("skipped");
  });

  test("an unresolvable body wikilink is de-linked to bold at persist time", async () => {
    let captured: InsertWikiProposalParams | null = null;
    const out = await draftSourcePage(
      baseDeps({
        index: fakeIndex([]), // resolves nothing
        callDrafter: async () =>
          mdxDraft({ body: "# RAG\n\nSee [[Nonexistent Page]].\n\n## See also\n- [[Nonexistent Page]]" }),
        insertProposal: async (p) => {
          captured = p;
          return { id: "r", ...p } as unknown as WikiProposal;
        },
      }),
    );
    expect(out.outcome).toBe("drafted");
    expect(captured!.draft).not.toContain("[[Nonexistent Page]]");
    expect(captured!.draft).toContain("**Nonexistent Page**");
  });

  test("a hallucinated frontmatter url is overwritten with the known input.url", async () => {
    let captured: InsertWikiProposalParams | null = null;
    const injected = `---\ntype: source\ntitle: Retrieval-Augmented Generation\naliases: [RAG]\ncreated: 2026-07-19\nupdated: 2026-07-19\ntags: [rag]\nurl: https://evil.example/injected\nsources: [${SOURCE_URL}]\n---\n\n# Retrieval-Augmented Generation\n\nRAG pairs retrieval with generation.\n\n## See also\n- [[Model Context Protocol]]`;
    const out = await draftSourcePage(
      baseDeps({
        callDrafter: async () => injected,
        insertProposal: async (p) => {
          captured = p;
          return { id: "r", ...p } as unknown as WikiProposal;
        },
      }),
    );
    expect(out.outcome).toBe("drafted");
    expect(captured!.draft).toContain(`url: ${SOURCE_URL}`);
    expect(captured!.draft).not.toContain("https://evil.example/injected");
  });

  test("a drafter throw is caught → error outcome (fire-and-forget safe)", async () => {
    const out = await draftSourcePage(
      baseDeps({
        callDrafter: async () => {
          throw new Error("model timeout");
        },
      }),
    );
    expect(out.outcome).toBe("error");
    if (out.outcome === "error") expect(out.reason).toContain("model timeout");
  });

  test("a life-domain category files the page under life/sources/", async () => {
    let captured: InsertWikiProposalParams | null = null;
    const deps = baseDeps({
      input: { ...baseDeps().input, category: "health" },
      insertProposal: async (p) => {
        captured = p;
        return { id: "r", ...p } as unknown as WikiProposal;
      },
    });
    const out = await draftSourcePage(deps);
    expect(out.outcome).toBe("drafted");
    if (out.outcome !== "drafted") throw new Error("expected drafted");
    expect(out.targetPath).toBe("life/sources/Retrieval-Augmented Generation.mdx");
    expect(captured!.targetPath).toBe("life/sources/Retrieval-Augmented Generation.mdx");
  });

  test("an absent / ai category defaults to the ai domain (sources/, no life prefix)", async () => {
    const out = await draftSourcePage(
      baseDeps({ input: { ...baseDeps().input, category: undefined } }),
    );
    expect(out.outcome).toBe("drafted");
    if (out.outcome === "drafted") expect(out.targetPath).toBe("sources/Retrieval-Augmented Generation.mdx");
  });

  test("a body just under MIN_SOURCE_BODY_CHARS → skipped 'summary too thin' (no draft call)", async () => {
    let drafted = false;
    const out = await draftSourcePage(
      baseDeps({
        input: { ...baseDeps().input, body: "x".repeat(MIN_SOURCE_BODY_CHARS - 1) },
        callDrafter: async () => {
          drafted = true;
          return mdxDraft();
        },
      }),
    );
    expect(out.outcome).toBe("skipped");
    if (out.outcome === "skipped") expect(out.reason).toContain("too thin");
    expect(drafted).toBe(false);
  });

  test("a body exactly at MIN_SOURCE_BODY_CHARS passes the guard → drafted", async () => {
    const out = await draftSourcePage(
      baseDeps({ input: { ...baseDeps().input, body: "x".repeat(MIN_SOURCE_BODY_CHARS) } }),
    );
    expect(out.outcome).toBe("drafted");
  });

  test("a thin body that is ALSO covered still reports covered (guard runs after the covered checks)", async () => {
    const out = await draftSourcePage(
      baseDeps({
        input: { ...baseDeps().input, body: "too thin" },
        collectWikiRefs: async () => ({ urls: new Set([SOURCE_URL]), idTokens: new Set() }),
      }),
    );
    expect(out.outcome).toBe("covered");
  });

  test("cross-vertical URL dedup: a live source proposal for the same URL → covered (no draft)", async () => {
    let drafted = false;
    const out = await draftSourcePage(
      baseDeps({
        // Same URL captured by another vertical, with a share param (`si=`) that
        // normalizeUrl strips — the dedup normalizes both sides before comparing.
        liveSourceDocUrls: async () => [`${SOURCE_URL}?si=abc123`],
        callDrafter: async () => {
          drafted = true;
          return mdxDraft();
        },
      }),
    );
    expect(out.outcome).toBe("covered");
    if (out.outcome === "covered") expect(out.reason).toContain("url");
    expect(drafted).toBe(false);
  });

  test("URL dedup is gated on an http url: two URL-less docs don't suppress each other", async () => {
    // A URL-less doc (pending-ingestion path). Even though the live set normalizes to
    // "", the empty input.url isn't http so the dedup is skipped and the draft proceeds.
    const out = await draftSourcePage(
      baseDeps({
        input: { ...baseDeps().input, url: "" },
        liveSourceDocUrls: async () => [""],
      }),
    );
    expect(out.outcome).toBe("drafted");
  });
});
