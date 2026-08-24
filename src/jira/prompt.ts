/**
 * The pure text pieces a Jira draft is assembled from and finished with.
 *
 * **The fenced PROMPT assembly is gone with the notes path** — the instruction →
 * riders → fenced-citations → fenced-raw-material builder, its system prompt and
 * its whole-prompt char cap all existed to turn pasted notes into one
 * server-side one-shot. A draft is a turn in a chat thread now, so the two riders are
 * appended to `buildThreadTurnInstruction`'s per-turn instruction
 * (`src/jira/thread-draft.ts`) instead, and what is left here is:
 *
 *  · the two riders (depth, language) — same text, new carrier,
 *  · `appendReferences`, which builds `## Referanser` SERVER-SIDE and
 *    deterministically, so every line resolves by construction,
 *  · the wrapping-fence strip both `finalize.ts` steps run.
 *
 * Pure + IO-free, like its siblings: no filesystem, no model, no huginn.
 */

import {
  MARKDOWN_WRAPPER_INFO_STRINGS,
  neutralizePromptFence,
  stripWrappingFence,
} from "../utils/prompt-fence.ts";
import type { JiraCitation, JiraDepth } from "./wire.ts";

/**
 * Collapse any `"""` run to a single quote.
 *
 * The instruction and the reader's steer are written into a per-turn instruction
 * block, so a field carrying its own fence can close it early and have whatever
 * follows read as instructions. The implementation is the shared
 * `neutralizePromptFence` (`src/utils/prompt-fence.ts`, dependency-free like this
 * file); the local name stays because the module's prose and tests call it that.
 */
export const neutralizeJiraFence = neutralizePromptFence;

/** The rider that pins how much technical solution the task carries. */
export function depthRider(depth: JiraDepth): string {
  if (depth === "ingen") {
    return (
      "TEKNISK DYBDE: INGEN. Skriv problem, verdi og akseptansekriterier. " +
      "Ikke nevn filer, klasser, tabeller eller endringsrekkefølge — utvikleren eier løsningen. " +
      "Hvis kildene beskriver en teknisk løsning, skal den likevel holdes utenfor."
    );
  }
  if (depth === "skisse") {
    return (
      "TEKNISK DYBDE: SKISSE. Legg til 3–5 punkter under en «## Teknisk skisse»-overskrift: " +
      "hvilke tjenester og klasser som berøres, og hvilken vei endringen går. " +
      "Ingen kode, ingen linjenumre, ingen migreringsplan — nok til å estimere, ikke nok til å låse designet."
    );
  }
  return (
    "TEKNISK DYBDE: FULL. Legg til en «## Teknisk løsning»-seksjon med fil- og linjereferanser på formen " +
    "`fil.kt:linje`, rekkefølgen endringene må gjøres i, eventuell migrering, HØYST ett kodeutdrag " +
    "(gjerdet, med språktag) og en kort risikovurdering.\n" +
    "REGEL, uten unntak: ikke påstå noe om koden slik den er i dag uten å ha åpnet filen med " +
    "kodeverktøyene. Har du ikke åpnet den, skriv hva som må undersøkes i stedet for å gjette."
  );
}

/** The language rider. Bokmål is stated explicitly, not left as an implied default —
 *  an unstated default is what a strongly-worded English source page overrides. */
export function languageRider(): string {
  return (
    "SPRÅK: skriv saken på norsk (bokmål), uansett hvilket språk kildene eller råmaterialet er på. " +
    "Behold produktnavn, egennavn, kodeidentifikatorer, tjenestenavn og siterte strenger i original form — " +
    "oversett prosaen rundt dem, ikke dem."
  );
}

/**
 * Append the `## Referanser` section.
 *
 * **Server-appended, deterministically, from the retained citations** — the model
 * is told not to write one. That is the whole point: PR 0 measured that a bare URL
 * becomes a Jira smart-link card and that a card for a nonexistent issue renders
 * **"Can't find link"**, so a full-URL reference to a hallucinated key is visibly
 * broken in the rendered description. Building the section from the citations we
 * actually retrieved means every line resolves BY CONSTRUCTION; a model-written
 * one would be the fabricated-key surface all over again, one line lower down.
 *
 * `[KEY](full-url)`, never a bare key. A source with no Jira key (a Confluence
 * page, a wiki page) renders `[title](url)`; one with no URL at all renders its
 * label as plain text, because a link to nowhere is worse than no link — and on
 * this corpus that is not hypothetical: `nav-wiki` documents carry
 * `file://./huginn-nav/wiki/…` paths, which `toJiraCitation` drops at the source.
 *
 * **It lists the depth slice, narrowed to what the draft actually NAMED** (see
 * `citationsNamedInDraft`), not the whole seeded set. Measured on a real `Ingen`
 * draft over 24 stored hits, appending the wide set put 24 links under a task
 * that leaned on a handful — references to material the text does not use.
 *
 * An empty citation list appends NOTHING — at `no_hits` there is no `## Referanser`
 * section at all, which is exactly how the reader tells that state from
 * `low_confidence`.
 */
export function appendReferences(markdown: string, citations: JiraCitation[]): string {
  if (citations.length === 0) return markdown.trimEnd();

  // ONE line per ISSUE, not per document. Two doc ids can carry the same key (a
  // re-indexed issue, a `_kopi` slug), and both being in the retained set put the
  // same issue in the list twice — once linked and, when the duplicate's url was
  // unusable, once BARE, which reads as two different sources.
  const byRef = new Map<string, JiraCitation>();
  for (const c of citations) {
    const ref = c.key ?? c.docId;
    const held = byRef.get(ref);
    // A linked spelling beats an unlinked one whichever order they arrive in —
    // the link is the whole reason the section is built server-side.
    if (!held || (!held.url && c.url)) byRef.set(ref, c);
  }

  const lines = [...byRef.values()].map((c) => {
    const label = c.key ?? c.title;
    // A Jira source shows `[KEY](url) — title`; everything else `[title](url)`,
    // so the title is never printed twice.
    const tail = c.key && c.title && c.title !== c.key ? ` — ${c.title}` : "";
    // The title rides the UNLINKED line too: a bare `MELOSYS-8028` tells the
    // reader nothing, and this line exists precisely because there is no link to
    // click through to.
    return c.url ? `- [${label}](${c.url})${tail}` : `- ${label}${tail}`;
  });
  return `${markdown.trimEnd()}\n\n## Referanser\n\n${lines.join("\n")}\n`;
}

/**
 * The info strings a JIRA draft may be wrapped in.
 *
 * The shared default is markdown-only (see `MARKDOWN_WRAPPER_INFO_STRINGS` — the
 * plaintext family was never argued for share, and a shared helper must not move
 * another surface's behaviour). This surface widens it deliberately, and every
 * addition is a tag a model reaches for when told "markdown only" and handed a
 * Jira task: the plaintext family, plus `jira`/`wiki`/`markup` — the three this
 * feature's own instruction wording makes likely. None of them can mean "the
 * output IS a code block", which is the one thing the allow-list protects: a
 * `Full` draft's ```` ```kotlin ```` excerpt is still left alone.
 */
export const JIRA_WRAPPER_INFO_STRINGS: ReadonlySet<string> = new Set([
  ...MARKDOWN_WRAPPER_INFO_STRINGS,
  "text", "txt", "plaintext", "plain",
  "jira", "wiki", "markup",
]);

/**
 * Drop a fence that wraps the WHOLE draft.
 *
 * Every shipped template says "markdown only, no wrapping code fence", and a
 * model that ignores it does not produce a slightly-off task — it produces a task
 * that pastes into Jira as one syntax-highlighted code block with the markdown
 * showing. The mechanics are the shared `src/utils/prompt-fence.ts` (this was a
 * byte copy of the share module's spelling, and the ```` ```markdown ```` gap
 * both carried had to be found twice); only the allow-list is this feature's.
 */
export function stripJiraWrappingFence(text: string): string {
  return stripWrappingFence(text, JIRA_WRAPPER_INFO_STRINGS);
}

// Deliberately NOT re-exported: a second door onto the shared helper is a door
// onto the NARROW default set, and a caller here that took it would leave a
// ```jira wrapper in the reader's clipboard with nothing to see in the diff.

