import { describe, test, expect } from "bun:test";
import { extractToolInputLabel, deriveSpanLabelHtml, abbreviateCollection, sortCollectionsByPriority, summarizeSearchTrace, normalizeToolName, fmtCost } from "./helpers.ts";

describe("fmtCost", () => {
  test("undefined/null degrade to a dash (unknown cost)", () => {
    expect(fmtCost(undefined)).toBe("—");
    expect(fmtCost(null)).toBe("—");
  });

  test("an explicit 0 renders $0.00 (subscription connectors), NOT a dash", () => {
    expect(fmtCost(0)).toBe("$0.00");
  });

  test("non-finite values degrade to a dash, never $NaN/$Infinity", () => {
    expect(fmtCost(Number.NaN)).toBe("—");
    expect(fmtCost(Number.POSITIVE_INFINITY)).toBe("—");
  });

  test("normal costs round to 2 decimals", () => {
    expect(fmtCost(0.0234)).toBe("$0.02");
    expect(fmtCost(1.5)).toBe("$1.50");
  });

  test("sub-cent positive costs keep 4 decimals so they aren't confused with $0.00", () => {
    expect(fmtCost(0.003)).toBe("$0.0030");
  });
});

describe("extractToolInputLabel", () => {
  test("returns empty string for falsy input", () => {
    expect(extractToolInputLabel(null)).toBe("");
    expect(extractToolInputLabel(undefined)).toBe("");
    expect(extractToolInputLabel("")).toBe("");
  });

  test("extracts priority key 'query' from JSON string", () => {
    expect(extractToolInputLabel('{"query":"search term","other":"ignored"}')).toBe("search term");
  });

  test("extracts priority key 'pattern' over non-priority keys", () => {
    expect(extractToolInputLabel('{"foo":"bar","pattern":"*.ts"}')).toBe("*.ts");
  });

  test("extracts priority key 'command' from object input", () => {
    expect(extractToolInputLabel({ command: "git status", verbose: true })).toBe("git status");
  });

  test("falls back to first string value when no priority key matches", () => {
    expect(extractToolInputLabel('{"count":42,"label":"my label"}')).toBe("my label");
  });

  test("skips non-string and empty string values", () => {
    expect(extractToolInputLabel('{"query":"","count":5,"label":"found"}')).toBe("found");
  });

  test("truncates at 140 characters", () => {
    const long = "a".repeat(160);
    const result = extractToolInputLabel({ query: long });
    expect(result).toBe("a".repeat(137) + "...");
    expect(result.length).toBe(140);
  });

  test("does not truncate string exactly 140 chars", () => {
    const exact = "a".repeat(140);
    expect(extractToolInputLabel({ query: exact })).toBe(exact);
  });

  test("returns empty string for empty object", () => {
    expect(extractToolInputLabel("{}")).toBe("");
  });

  test("returns empty string for invalid JSON", () => {
    expect(extractToolInputLabel("not json")).toBe("");
  });

  test("returns empty string for object with only non-string values", () => {
    expect(extractToolInputLabel('{"count":5,"enabled":true,"items":[1,2]}')).toBe("");
  });

  test("respects priority order: query before command", () => {
    expect(extractToolInputLabel({ command: "ls", query: "search" })).toBe("search");
  });

  test("respects priority order: file_path before arbitrary key", () => {
    expect(extractToolInputLabel({ custom: "custom val", file_path: "/src/index.ts" })).toBe("/src/index.ts");
  });
});

describe("deriveSpanLabelHtml", () => {
  test("returns null when there's nothing chippable", () => {
    expect(deriveSpanLabelHtml({ name: "claude" })).toBeNull();
    // No trace, no collection input, no query input → genuinely nothing to show.
    expect(deriveSpanLabelHtml({ name: "knowledge-search_knowledge", attributes: { input: {} } })).toBeNull();
  });

  test("renders verb chip + collection chip from input.collection", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: { input: { collection: "jira-issues" } },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('class="wf-chip wf-verb wf-verb-search"');
    expect(out!.html).toContain(">search<");
    expect(out!.html).toContain('class="wf-chip wf-coll"');
    expect(out!.html).toContain(">jira-issues<");
    expect(out!.html).not.toContain("wf-coll-more");
    expect(out!.html).not.toContain("wf-trace-dot");
  });

  test("includes a +N chip and tooltip listing the extra collections (wiki promoted to primary)", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "melosys-confluence-v3" }, { name: "jira-issues" }, { name: "nav-wiki" }],
        },
      },
    });
    expect(out).not.toBeNull();
    // wiki sorts to the front and becomes the primary chip
    expect(out!.html).toContain(">nav-wiki<");
    expect(out!.html).toContain('class="wf-chip wf-coll-more"');
    expect(out!.html).toContain(">+2<");
    // remaining tooltip lists the others in original (non-wiki) order
    expect(out!.html).toContain('title="melosys-confluence-v3, jira-issues"');
  });

  test("does not emit the legacy trace dot (counts chip + detail panel cover the same signal)", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        input: { collection: "kb" },
        searchTrace: { schemaVersion: 1, collections: [{ name: "kb" }] },
      },
    });
    expect(out!.html).not.toContain("wf-trace-dot");
    expect(out!.html.startsWith('<span class="wf-chip wf-verb')).toBe(true);
  });

  test("uses verb class 'other' for tool names that don't reduce to letters-only", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-123foo",
      attributes: { input: { collection: "kb" } },
    });
    expect(out!.html).toContain("wf-verb-other");
  });

  test("escapes HTML in collection names", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: { input: { collection: "<script>alert(1)</script>" } },
    });
    expect(out!.html).toContain("&lt;script&gt;");
    expect(out!.html).not.toContain("<script>alert");
  });

  test("abbreviates the chip for long collection names and puts full name in title", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: { input: { collection: "melosys-confluence-v3" } },
    });
    expect(out!.html).toContain(">mc-v3<");
    expect(out!.html).not.toContain(">melosys-confluence-v3<");
    expect(out!.html).toContain('title="melosys-confluence-v3 (mc-v3)"');
  });

  test("keeps short collection names verbatim with no abbreviation note", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: { input: { collection: "jira-issues" } },
    });
    expect(out!.html).toContain(">jira-issues<");
    expect(out!.html).toContain('title="jira-issues"');
  });

  test("yggdrasil-shaped trace synthesizes a 'yggdrasil' chip and 'search' verb", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-search",
      attributes: { searchTrace: { schemaVersion: 1, tool: "search" } },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-search");
    expect(out!.html).toContain(">search<");
    expect(out!.html).toContain(">yggdrasil<");
  });

  test("renders a counts chip with kept/fetched for huginn collections", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{
            name: "kb",
            candidates: [
              { kept: true, docTitle: "Top hit", stages: { final: { rank: 1 } } },
              { kept: true, stages: { final: { rank: 2 } } },
              { kept: false, dropReason: "noise" },
            ],
            confidence: { lowConfidence: false },
            timingsMs: { total: 63 },
          }],
          totalMs: 71,
        },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('class="wf-chip wf-counts"');
    expect(out!.html).toContain(">2/3<");
    expect(out!.html).not.toContain("wf-low-conf");
    expect(out!.tooltip).toContain("candidates: 2 kept / 3 fetched");
    expect(out!.tooltip).toContain("top: Top hit");
    expect(out!.tooltip).toContain("total: 71ms");
  });

  test("counts chip tooltip notes the cross-collection sum when there are multiple collections", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [
            { name: "wiki", candidates: [{ kept: true }, { kept: true }], confidence: { lowConfidence: false } },
            { name: "jira", candidates: [{ kept: true }], confidence: { lowConfidence: false } },
            { name: "kb",   candidates: [{ kept: true }], confidence: { lowConfidence: false } },
          ],
        },
      },
    });
    expect(out!.html).toMatch(/title="[^"]*summed across 3 collections/);
    // Single-collection case keeps the original short tooltip.
    const single = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "wiki", candidates: [{ kept: true }], confidence: { lowConfidence: false } }],
        },
      },
    });
    expect(single!.html).not.toContain("summed across");
  });

  test("shows a '0 hits' chip (not the candidate count) when the search returned nothing to the model", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        output: "No results found for 'meningen med livet' (low confidence).\n\n*No confident match — try: related terms: a, b*",
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "kb", candidates: [{ kept: true }, { kept: true }, { kept: true }], confidence: { lowConfidence: false } }],
        },
      },
    });
    expect(out!.html).toContain("wf-chip wf-no-hits");
    expect(out!.html).toContain(">0 hits<");
    expect(out!.html).not.toContain(">2/3<"); // candidate count suppressed
    expect(out!.tooltip).toContain("no results returned to the model");
  });

  test("flips counts chip to low-conf variant when the output carries a weak-match footer", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        output: "## A doc (18% relevant · low)\ncollection: `kb` doc_id: `1`\n\nbody\n\n*Weak match — try: broader query: \"x\"*",
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "kb", candidates: [{ kept: true }, { kept: true }], confidence: { lowConfidence: false } }],
        },
      },
    });
    expect(out!.html).toContain("wf-chip wf-counts wf-low-conf");
    expect(out!.tooltip).toContain("low-confidence results");
  });

  test("renders 'rescue ⟲N' chip with rescued-verdict tooltip when Path-D rescue improved the result", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "kb", candidates: [{ kept: true }] }],
          response: {
            bestScore: 0.954,
            noConfidentResults: false,
            corrective: {
              mode: "auto",
              retries: 1,
              verdict: "rescued",
              rescueFired: true,
              queriesTried: ["meningen med livet", "meningen"],
            },
          },
        },
      },
    });
    expect(out!.html).toContain("wf-chip wf-rescue");
    expect(out!.html).toContain("rescue ⟲1");
    expect(out!.tooltip).toContain("Huginn rescued via 1 retry");
    expect(out!.tooltip).not.toContain("still weak");
    expect(out!.tooltip).toContain("\"meningen med livet\" → \"meningen\"");
  });

  test("deduplicates collections from duplicate searchTrace entries (Path-D rescue pass)", () => {
    // Huginn emits one `searchTrace.collections` entry per searcher.search()
    // call, so a rescued single-collection search produces e.g.
    // [{name: "nav-wiki"}, {name: "nav-wiki"}]. The dashboard should render
    // the collection chip once, not as "nav-wiki +1".
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [
            { name: "nav-wiki", candidates: [{ kept: true }] },
            { name: "nav-wiki", candidates: [] }, // rescue pass, same collection
          ],
          response: {
            corrective: {
              rescueFired: true,
              retries: 1,
              verdict: "still_weak",
              queriesTried: ["meningen med livet", "meningen"],
            },
          },
        },
      },
    });
    expect(out!.html).toContain("nav-wiki");
    expect(out!.html).not.toContain("wf-coll-more");
    expect(out!.html).not.toContain("+1");
    // Rescue chip still renders alongside the deduped single-collection chip
    expect(out!.html).toContain("rescue ⟲1");
  });

  test("renders rescue chip with still-weak tooltip when Path-D rescue fired but didn't find anything better", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "kb", candidates: [{ kept: true }] }],
          response: {
            bestScore: 0,
            noConfidentResults: true,
            corrective: {
              mode: "force",
              retries: 1,
              verdict: "still_weak",
              rescueFired: true,
              queriesTried: ["meningen med livet", "meningen"],
            },
          },
        },
      },
    });
    expect(out!.html).toContain("wf-chip wf-rescue");
    expect(out!.html).toContain("rescue ⟲1");
    expect(out!.tooltip).toContain("Huginn attempted rescue (still weak): 1 retry");
    expect(out!.tooltip).not.toContain("Huginn rescued via");
  });

  test("rescue chip shows '⟲N' and plural 'retries' for multiple retries", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "kb", candidates: [{ kept: true }] }],
          response: {
            corrective: {
              rescueFired: true,
              retries: 2,
              verdict: "rescued",
              queriesTried: ["q1", "q2", "q3"],
            },
          },
        },
      },
    });
    expect(out!.html).toContain("rescue ⟲2");
    expect(out!.tooltip).toContain("Huginn rescued via 2 retries");
  });

  test("no rescue chip when corrective fired but didn't rescue (verdict=confident)", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "kb", candidates: [{ kept: true }] }],
          response: {
            corrective: {
              mode: "auto",
              retries: 0,
              verdict: "confident",
              rescueFired: false,
              queriesTried: ["foo"],
            },
          },
        },
      },
    });
    expect(out!.html).not.toContain("wf-rescue");
    expect(out!.tooltip).not.toContain("rescued");
  });

  test("no rescue chip when corrective block is missing (pre-Path-D traces)", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "kb", candidates: [{ kept: true }] }],
          response: { bestScore: 0.8 },
        },
      },
    });
    expect(out!.html).not.toContain("wf-rescue");
  });

  test("flips counts chip to low-conf variant when any collection is low-confidence", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{
            name: "kb",
            candidates: [{ kept: true, docTitle: "x" }],
            confidence: { lowConfidence: true },
          }],
        },
      },
    });
    expect(out!.html).toContain("wf-chip wf-counts wf-low-conf");
    expect(out!.tooltip).toContain("low confidence");
  });

  test("renders counts chip and tooltip from yggdrasil flat candidates", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-search",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          tool: "search",
          candidates: [
            { qualifiedName: "com.example.Foo", stages: { final: { rank: 1 } } },
            { qualifiedName: "com.example.Bar", stages: { final: { rank: 2 } } },
            { qualifiedName: "com.example.Baz" }, // no final stage → not kept
          ],
          timingsMs: { total: 42 },
        },
      },
    });
    expect(out!.html).toContain(">2/3<");
    expect(out!.tooltip).toContain("top: com.example.Foo");
    expect(out!.tooltip).toContain("total: 42ms");
  });

  // ─── Per-tool extras path (no searchTrace, no input.collection) ───────────
  test("knowledge-get_graph_node renders kind + id chips from node_id", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-get_graph_node",
      attributes: { input: { node_id: "epic:MELOSYS-7383" } },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-get");
    expect(out!.html).toContain(">epic<");           // kind chip
    expect(out!.html).toContain(">MELOSYS-7383<");   // id chip (after colon)
    expect(out!.html).toContain("wf-extra");
    expect(out!.tooltip).toContain("node: epic:MELOSYS-7383");
  });

  test("knowledge-get_graph_node falls back to bare id when no colon", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-get_graph_node",
      attributes: { input: '{"node_id":"foo"}' }, // string-encoded input
    });
    expect(out!.html).toContain(">foo<");
    expect(out!.html).not.toMatch(/>kind:/);
  });

  test("yggdrasil-symbol_context renders repo + short symbol name", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-symbol_context",
      attributes: {
        input: {
          qualified_name: "no.nav.melosys.saksflyt.steg.soknad.OpprettOgFerdigstillJournalpostSøknad",
          repo: "melosys-api",
        },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-symbol");
    expect(out!.html).toContain(">melosys-api<");
    expect(out!.html).toContain(">OpprettOgFerdigstillJournalpostSøknad<");
    expect(out!.tooltip).toContain("repo: melosys-api");
    expect(out!.tooltip).toContain("symbol: no.nav.melosys.saksflyt.steg.soknad.OpprettOgFerdigstillJournalpostSøknad");
  });

  test("yggdrasil-list_files renders repo + last path segment", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-list_files",
      attributes: { input: { repo: "melosys-api", path: "saksflyt/src/main/kotlin/no/nav/melosys/saksflyt/prosessflyt" } },
    });
    expect(out!.html).toContain(">melosys-api<");
    expect(out!.html).toContain(">prosessflyt<");
    expect(out!.tooltip).toContain("path: saksflyt/src/main/kotlin/no/nav/melosys/saksflyt/prosessflyt");
  });

  test("yggdrasil-read_source renders repo + basename", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-read_source",
      attributes: { input: { repo: "melosys-api", path: "src/main/kotlin/Foo.kt" } },
    });
    expect(out!.html).toContain(">melosys-api<");
    expect(out!.html).toContain(">Foo.kt<");
  });

  test("yggdrasil-analyze_ticket renders repo + truncated ticket excerpt", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-analyze_ticket",
      attributes: {
        input: {
          repo: "melosys-api",
          ticket: "Behandling skal ikke kunne avsluttes uten at det finnes et grunnlag",
          top_k: 5,
          max_depth: 2,
        },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-analyze");
    expect(out!.html).toContain(">melosys-api<");
    expect(out!.html).toContain("…"); // truncation marker
    expect(out!.tooltip).toContain("repo: melosys-api");
    expect(out!.tooltip).toContain("ticket: Behandling skal ikke kunne avsluttes uten at det finnes et grunnlag");
  });

  test("yggdrasil-analyze_ticket renders ticket-only when repo is missing", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-analyze_ticket",
      attributes: { input: { ticket: "Some short ticket" } },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-analyze");
    expect(out!.html).toContain(">Some short ticket<");
  });

  // analyze_ticket inputs are large enough that the 500-char truncation
  // typically cuts off the trailing `repo` field. Recover it from
  // output.summary.repos so the row keeps a colored repo chip.
  test("yggdrasil-analyze_ticket recovers repo from output.summary.repos when input lacks it", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-analyze_ticket",
      attributes: {
        input: { ticket: "MELOSYS-7999: ..." },
        output: JSON.stringify({
          ticket: { text: "..." },
          symbols: [],
          candidates: [],
          summary: { total_candidates: 6, repos: ["melosys-api"] },
        }),
      },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-analyze");
    expect(out!.html).toContain(">melosys-api<");
    expect(out!.tooltip).toContain("repo: melosys-api");
  });

  // Tool inputs are abbreviated to 500 chars upstream — a long ticket arrives
  // as malformed JSON ending with `…`. Strict JSON.parse fails, so the parser
  // must recover string fields via regex; otherwise the row falls back to the
  // bare tool name with no chips.
  test("yggdrasil-analyze_ticket renders chips even when input JSON is truncated", () => {
    const truncated =
      '{"ticket":"MELOSYS-7999: Journalføring søknader på eksisterende eller ny sak — ' +
      "lots of additional text that runs past the 500-char abbreviation cap and the closing quote is missing…";
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-analyze_ticket",
      attributes: { input: truncated },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-analyze");
    expect(out!.html).toContain("MELOSYS-7999"); // recovered from truncated JSON
  });

  test("yggdrasil-search_pattern renders repo + truncated pattern", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-search_pattern",
      attributes: {
        input: { repo: "melosys-api", pattern: "MELOSYS_MOTTAK_EKSISTERENDE_DIGITAL|OPPRETT_GOSYS_OPPGAVE" },
      },
    });
    expect(out!.html).toContain("wf-verb-search");
    expect(out!.html).toContain(">melosys-api<");
    expect(out!.html).toContain("…"); // truncation marker
    expect(out!.tooltip).toContain("pattern: MELOSYS_MOTTAK_EKSISTERENDE_DIGITAL|OPPRETT_GOSYS_OPPGAVE");
  });

  test("repo chip uses the same color as the matching collection chip", () => {
    // Same repo name on two different tools should produce the same inline style
    // (deterministic HSL hash) so the user can visually correlate them.
    const a = deriveSpanLabelHtml({
      name: "yggdrasil-list_files",
      attributes: { input: { repo: "melosys-api", path: "x" } },
    });
    const b = deriveSpanLabelHtml({
      name: "yggdrasil-read_source",
      attributes: { input: { repo: "melosys-api", path: "x.kt" } },
    });
    const styleA = /style="([^"]+)"[^>]*>melosys-api</.exec(a!.html)?.[1];
    const styleB = /style="([^"]+)"[^>]*>melosys-api</.exec(b!.html)?.[1];
    expect(styleA).toBe(styleB);
    expect(styleA).toBeTruthy();
  });

  test("returns null when per-tool input is missing all extractable fields", () => {
    expect(deriveSpanLabelHtml({
      name: "yggdrasil-symbol_context",
      attributes: { input: {} },
    })).toBeNull();
  });

  // When huginn fails to attach a trace (intermittent — large responses get
  // truncated past the trace fence) AND the input has no `collection` field,
  // the row label was previously plain text. Recipe falls back to the query so
  // the row stays informative.
  test("knowledge-search_knowledge falls back to query chip when trace+collection both missing", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        toolName: "knowledge-search_knowledge",
        input: { query: "MELOSYS-7999 journalføring søknad", brief: false },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-search");
    expect(out!.html).toContain(">MELOSYS-7999"); // truncated query as extra chip
    expect(out!.tooltip).toContain("query: MELOSYS-7999 journalføring søknad");
  });

  test("knowledge-search_knowledge: searchTrace path still wins when trace is present", () => {
    // When trace IS attached, the collections-from-trace branch fires first and
    // returns its rich count chip — the fallback recipe must not interfere.
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        toolName: "knowledge-search_knowledge",
        input: { query: "x", brief: false },
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "jira-issues", candidates: [{ kept: true, stages: { final: { rank: 1 } } }] }],
        },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain(">jira-issues<"); // came from trace, not from input
    expect(out!.html).toContain("wf-counts"); // count chip from search-trace path
  });

  // Claude CLI emits "mcp__yggdrasil__symbol_context"; copilot SDK emits
  // "yggdrasil-symbol_context". Both must produce the same chip cluster — the
  // dispatcher used to only match the dash form, so claude-cli rows fell
  // through to a plain text label.
  test("claude-cli mcp__ form produces same chips as copilot-sdk dash form", () => {
    const dash = deriveSpanLabelHtml({
      name: "yggdrasil-symbol_context",
      attributes: { input: { qualified_name: "no.nav.x.Foo", repo: "melosys-api" } },
    });
    const mcp = deriveSpanLabelHtml({
      name: "mcp__yggdrasil__symbol_context",
      attributes: { input: { qualified_name: "no.nav.x.Foo", repo: "melosys-api" } },
    });
    expect(mcp).not.toBeNull();
    expect(mcp!.html).toBe(dash!.html);
  });

  // Production claude-cli spans store the *display-formatted* name in span.name
  // ("symbol_context (yggdrasil)") and the raw tool name in attrs.toolName.
  // Dispatcher must use attrs.toolName, not span.name — earlier this asymmetry
  // is what made claude-cli rows render plain text in the trace waterfall.
  test("dispatch uses attrs.toolName when set, ignoring formatted span.name", () => {
    const out = deriveSpanLabelHtml({
      name: "symbol_context (yggdrasil)",
      attributes: {
        toolName: "mcp__yggdrasil__symbol_context",
        input: { qualified_name: "no.nav.x.Foo", repo: "melosys-api" },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-symbol");
    expect(out!.html).toContain(">melosys-api<");
    expect(out!.html).toContain(">Foo<");
  });

  test("claude-cli mcp__ form: graph_node renders verb + kind + id", () => {
    const out = deriveSpanLabelHtml({
      name: "mcp__knowledge__get_graph_node",
      attributes: { input: { node_id: "epic:MELOSYS-7383" } },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-get");
    expect(out!.html).toContain(">epic<");
    expect(out!.html).toContain(">MELOSYS-7383<");
  });

  test("claude-cli mcp__ form: read_source/list_files/search_pattern all render chips", () => {
    expect(deriveSpanLabelHtml({
      name: "mcp__yggdrasil__read_source",
      attributes: { input: { repo: "melosys-api", path: "src/Foo.kt" } },
    })!.html).toContain(">Foo.kt<");
    expect(deriveSpanLabelHtml({
      name: "mcp__yggdrasil__list_files",
      attributes: { input: { repo: "melosys-api", path: "src/main" } },
    })!.html).toContain(">main<");
    expect(deriveSpanLabelHtml({
      name: "mcp__yggdrasil__search_pattern",
      attributes: { input: { repo: "melosys-api", pattern: "FOO" } },
    })!.html).toContain(">FOO<");
  });
});

describe("normalizeToolName", () => {
  test("strips mcp__ prefix and converts last __ to dash", () => {
    expect(normalizeToolName("mcp__yggdrasil__symbol_context")).toBe("yggdrasil-symbol_context");
    expect(normalizeToolName("mcp__knowledge__get_graph_node")).toBe("knowledge-get_graph_node");
  });

  test("preserves underscores within the server name (only last __ converts)", () => {
    expect(normalizeToolName("mcp__claude_ai_Context7__query-docs")).toBe("claude_ai_Context7-query-docs");
  });

  test("passes through dash form unchanged", () => {
    expect(normalizeToolName("yggdrasil-symbol_context")).toBe("yggdrasil-symbol_context");
    expect(normalizeToolName("knowledge-search_knowledge")).toBe("knowledge-search_knowledge");
  });

  test("passes through built-in tool names unchanged", () => {
    expect(normalizeToolName("Read")).toBe("Read");
    expect(normalizeToolName("Bash")).toBe("Bash");
  });

  test("handles empty / malformed input safely", () => {
    expect(normalizeToolName("")).toBe("");
    expect(normalizeToolName("mcp__notool")).toBe("mcp__notool");
  });
});

describe("summarizeSearchTrace", () => {
  test("returns null for non-objects", () => {
    expect(summarizeSearchTrace(null)).toBeNull();
    expect(summarizeSearchTrace(undefined)).toBeNull();
    expect(summarizeSearchTrace("foo")).toBeNull();
  });

  test("returns null when neither shape has candidates", () => {
    expect(summarizeSearchTrace({ schemaVersion: 1 })).toBeNull();
    expect(summarizeSearchTrace({ collections: [] })).toBeNull();
    expect(summarizeSearchTrace({ candidates: [] })).toBeNull();
  });

  test("aggregates kept/fetched across multiple huginn collections", () => {
    const s = summarizeSearchTrace({
      collections: [
        { candidates: [{ kept: true }, { kept: false }] },
        { candidates: [{ kept: true }, { kept: true }, { kept: false }] },
      ],
    });
    expect(s).toEqual({ kept: 3, fetched: 5, topTitle: null, lowConfidence: false, totalMs: null });
  });

  test("picks top hit by lowest final.rank from first huginn collection", () => {
    const s = summarizeSearchTrace({
      collections: [{
        candidates: [
          { docTitle: "second", stages: { final: { rank: 2 } } },
          { docTitle: "first", stages: { final: { rank: 1 } } },
        ],
      }],
    });
    expect(s!.topTitle).toBe("first");
  });

  test("falls back to documentId when docTitle is missing", () => {
    const s = summarizeSearchTrace({
      collections: [{ candidates: [{ documentId: "doc-abc", stages: { final: { rank: 1 } } }] }],
    });
    expect(s!.topTitle).toBe("doc-abc");
  });

  test("yggdrasil shape: kept counts candidates with stages.final, top picks lowest rank", () => {
    const s = summarizeSearchTrace({
      tool: "search",
      candidates: [
        { qualifiedName: "B", stages: { final: { rank: 2 } } },
        { qualifiedName: "A", stages: { final: { rank: 1 } } },
        { qualifiedName: "C" },
      ],
      timingsMs: { total: 33 },
    });
    expect(s).toEqual({ kept: 2, fetched: 3, topTitle: "A", lowConfidence: false, totalMs: 33 });
  });
});

describe("sortCollectionsByPriority", () => {
  test("moves any wiki-containing entry to the front", () => {
    expect(sortCollectionsByPriority(["melosys-confluence-v3", "jira-issues", "nav-wiki"]))
      .toEqual(["nav-wiki", "melosys-confluence-v3", "jira-issues"]);
  });

  test("preserves original order when no priority match", () => {
    expect(sortCollectionsByPriority(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("preserves original order among multiple wiki entries", () => {
    expect(sortCollectionsByPriority(["jira", "alpha-wiki", "beta-wiki", "confluence"]))
      .toEqual(["alpha-wiki", "beta-wiki", "jira", "confluence"]);
  });

  test("matches case-insensitively", () => {
    expect(sortCollectionsByPriority(["jira", "Internal-WIKI"]))
      .toEqual(["Internal-WIKI", "jira"]);
  });
});

describe("abbreviateCollection", () => {
  test("returns empty string for empty input", () => {
    expect(abbreviateCollection("")).toBe("");
  });

  test("keeps names ≤ 12 chars verbatim", () => {
    expect(abbreviateCollection("jira-issues")).toBe("jira-issues");
    expect(abbreviateCollection("nav-wiki")).toBe("nav-wiki");
    expect(abbreviateCollection("kb")).toBe("kb");
  });

  test("collapses long names to first-letter initials per dash segment", () => {
    expect(abbreviateCollection("very-long-collection-name")).toBe("vlcn");
  });

  test("preserves trailing version-like tokens", () => {
    expect(abbreviateCollection("melosys-confluence-v3")).toBe("mc-v3");
    expect(abbreviateCollection("foo-bar-baz-2")).toBe("fbb-2");
    expect(abbreviateCollection("alpha-beta-gamma-v1-2")).toBe("abg-v1-2");
  });

  test("returns single-token names unchanged when long", () => {
    expect(abbreviateCollection("supercalifragilistic")).toBe("supercalifragilistic");
  });
});
