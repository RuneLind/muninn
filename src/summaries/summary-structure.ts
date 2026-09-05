/**
 * The structure rules every capture summary carries — a dependency-free leaf.
 *
 * Split out of `summarizer-shared.ts` (which re-exports it under the same name)
 * because `presets.ts` interpolates these bullets into the shipped capture
 * kinds and must stay pure: the shared seam imports the executor, the tracer
 * and the connector graph, none of which a preset resolution or a page render
 * should load.
 */

/**
 * Shared structured-summary rules used by every capture vertical (youtube /
 * x-article / anthropic / article via `buildSummarySystemPrompt` in `summarizer-shared.ts`, and tiktok inline).
 *
 * The contract is deliberately uniform so stored summaries read consistently on
 * /summaries AND make clean drafter input downstream: one italic ingress line
 * orients the reader, a `## Key takeaways` section leads the body, `##`-level
 * headings structure the rest, tables appear only for genuinely comparative
 * content, a closing blockquote distills the headline revelations, and the
 * output is PLAIN markdown — no block components (Callout/Verdict/Pill/etc.),
 * a stated non-goal for stored summaries.
 *
 * The verbatim-artifact rule is the one exception to "concise but
 * comprehensive": summarizing is the wrong operation for material meant to be
 * reused, and no vertical retains its source text to recover it from — `BaseJob`
 * carries `text`/`summary` only and every ingest body posts the summary, not the
 * transcript. Most sources are re-fetchable from the stored url (and youtube's
 * transcript from huginn), so recovery means re-running the whole capture; the
 * two PASTED paths — `src/article/` (POST field `text`) and x-article's TEXT
 * path (POST field `article_text`); x-article's VIDEO path re-downloads like
 * the rest — have nothing to re-run, and their loss is final.
 *
 * The rule's "never invent one" half is load-bearing rather than decoration: a
 * rule that only demanded a fenced prompt would be satisfied by writing a
 * plausible one for a source that merely mentions having one.
 *
 * The excerpt and close-the-fence clauses are the counterweights to "verbatim",
 * and they defend one failure: the model's own output ceiling binds the whole
 * summary, so an unbounded quote can run out MID-FENCE. An unclosed fence is not
 * a code block — `src/format/markdown-ast.ts` runs those lines through the
 * ordinary block parser, so a heading, a list or a `<Callout>` inside one
 * RENDERS (the tag is consumed, not shown), which is the wikilinks-inside-code
 * class (`src/web/CLAUDE.md`) arriving through the prompt instead of the
 * renderer.
 *
 * Two review rounds were spent trying to carve markup OUT of that hazard, and
 * the enumeration is why the attempt was abandoned rather than narrowed again:
 * `COMPONENT_NAMES` registers FIFTEEN components and a denylist naming six left
 * nine live — measured by driving `formatWebHtml` over every registered name
 * inside an unclosed fence: PAIRED (`<X>body</X>`) all 15 are consumed, none
 * escaped; self-closing only 4 are — and a sixteenth would go stale silently.
 * So there is no markup exemption at all: "plain markdown only" applies
 * everywhere, which is what keeps component markup out of the output in the
 * first place, and a source dictating markup is described rather than quoted.
 * `mermaid` is named separately because it is the one language a reader
 * rewrites out of a CLOSED fence, replacing the block with a drawn diagram.
 *
 * BOTH of those hazards are PROSPECTIVE, and saying so is the point — two
 * rounds were spent on them reading as live. A stored summary today goes to
 * `/summaries`, which renders with marked.js and an escaping `html` renderer
 * (`views/components/{doc-panel,sum-job-card}.ts`), so no component is parsed;
 * to the huginn doc; and to chat, which runs no mermaid at all (`enhanceMermaid`
 * is the /wiki reader, the Ask pane and /research — see `wiki-mermaid.ts`).
 * The channel to a renderer that does either is `src/gardener/source-drafter.ts`,
 * and it is doubly indirect: that prompt REWRITES rather than copies ("synthesize,
 * don't transcribe", :196) and itself mandates a mermaid fence and permits
 * components (:197-198). These rules are cheap, so they are priced for the day
 * that channel becomes direct rather than for today.
 *
 * The ingress + closer restore what the pre-#309 loose prompt produced
 * emergently on the best summaries (and inconsistently on the rest): an
 * orientation line up top and a memorable distillation at the bottom. The
 * `## Key takeaways` section stays the FIRST *section* — nothing parses the
 * body positionally, but /summaries scanability and drafter-input uniformity
 * were the point of the restructure and are preserved.
 */
export const SUMMARY_STRUCTURE_BULLETS = [
  "- Open the summary with ONE *italic* ingress line (max ~30 words): what/who this is and why it matters — e.g. *Interview with Tom Griffiths, Princeton professor of psychology & CS, about his book tracing the mathematical history of cognition.*",
  "- Then a `## Key takeaways` section FIRST (before any other section) — 3–6 tight bullet points, one line each, capturing the most important points.",
  "- Then `##`-level section headers for each major topic; use `###` only for sub-sections. Keep the heading hierarchy consistent.",
  "- When the source DICTATES something meant to be reused — a prompt, a command, a config, a query, a formula, a code snippet (\"the prompt I use is…\", \"run this…\", text shown on screen) — reproduce it VERBATIM inside a fenced code block, under a short line saying what it is. Never paraphrase or shorten it: for these, fidelity beats brevity and the \"keep it concise\" rule below does not apply. ALWAYS close the fence, and never label one `mermaid` — that is drawn, not shown. Quote it whole; only when it will not fit, quote the essential part, mark it `(excerpted)`, and still close the fence — never truncate silently. When what is dictated is itself markup the \"plain markdown only\" rule below forbids, describe it in prose rather than quoting it. If the source names such an artifact without ever giving its text, say so — never invent one.",
  "- Use a markdown table when the content is genuinely comparative (options side by side, before/after, feature or tradeoff matrices) — don't force a table onto non-comparative content.",
  "- **Bold** for key terms; bullet lists for enumerations, prefixed with a fitting emoji (as in `- 🧪 Evals catch…`).",
  "- Plain markdown only — no HTML and no custom block components (no callouts, cards, verdicts, or pills).",
  "- Keep it concise but comprehensive.",
  "- End with a closing blockquote takeaway: `> 💬 **Takeaway:** …` — the 1–3 most surprising or headline revelations, distilled into one or two punchy sentences.",
];
