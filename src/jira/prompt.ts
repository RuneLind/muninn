/**
 * Prompt assembly for the Jira composer — the last pure step before the model call.
 *
 * The order is the contract: **template instruction → depth rider → language
 * rider → the reader's extra steer → fenced citations → fenced raw material**.
 * Riders go AFTER the instruction for the reason `src/share/prompt.ts` documents:
 * a per-bot template rewrites the SHAPE of the task, not the depth dial the
 * reader just set or the language the wiki is written in — putting the riders
 * first let an override silently win and made the controls decorative.
 *
 * **`SYNTHESIS_RULES_BODY` from `research/answer.ts` is deliberately NOT reused.**
 * It drags in `COMPONENT_VOCABULARY_RULES`, which instructs the model to emit
 * `<Callout>`/`<Verdict>`/`<Pill>` — exactly the HTML-ish tags the measured Jira
 * paste subset forbids and `markdown-check.ts` flags. Its `renderSourcesBlock` is
 * likewise not reused: `## Referanser` is appended by THIS module, deterministically,
 * from the retained citations.
 *
 * Pure + IO-free, like its siblings: no filesystem, no model, no huginn.
 */

import {
  MARKDOWN_WRAPPER_INFO_STRINGS,
  neutralizePromptFence,
  stripWrappingFence,
} from "../utils/prompt-fence.ts";
import type { JiraCitation, JiraDepth } from "./wire.ts";
import { JIRA_BODY_MAX } from "./wire.ts";
import type { JiraFullDoc } from "./retrieval.ts";

/**
 * Collapse any `"""` run to a single quote.
 *
 * The raw material and the reader's own fields are written INTO `"""`-fenced
 * blocks below, so a field carrying its own fence can close the block early and
 * have whatever follows read as instructions. **A pasted Slack thread is the
 * highest-risk input in this feature** — it is the one field that routinely
 * contains code, quotes and other people's text — so this is not theoretical.
 * The implementation is the shared `neutralizePromptFence`
 * (`src/utils/prompt-fence.ts`, dependency-free like this file); the local name
 * stays because the module's prose and tests call it that.
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
 * The system prompt. Deliberately thin: the TEMPLATE carries the instruction and
 * the shipped rules (the measured markdown subset, no invented keys, no derived
 * numbers), so anything restated here would be a second, drifting copy of the
 * contract a bot's `jiraTemplate.<id>.md` is allowed to replace.
 */
export function buildJiraSystemPrompt(): string {
  return (
    "Du skriver Jira-saker for NAV/Melosys ut fra løst råmateriale — et møtereferat, en Slack-tråd " +
    "eller notater fra en refinement. Følg instruksjonen under nøyaktig. " +
    "Teksten limes rett inn i Jiras beskrivelsesfelt, så den må være ferdig som den står: " +
    "svar med selve saken og ingenting annet — ingen innledning, ingen kommentar til oppgaven."
  );
}

export interface JiraTaskInput {
  /** The resolved template's content. */
  instruction: string;
  depth: JiraDepth;
  /** Free-text steer from the page ("fokuser på migreringsrisikoen"). */
  extra?: string;
  /** The RETAINED citations — already excluded and renumbered. */
  citations: JiraCitation[];
  /** `Full` only: whole documents pulled on top of the snippets. */
  fullDocs?: JiraFullDoc[];
  /** The reader's raw material. */
  notes: string;
}

/**
 * Render the sources block. Our own, not `renderSourcesBlock` — the badge/key
 * framing is this feature's.
 *
 * **Deliberately UNNUMBERED.** It led each source with `[n]` while
 * `appendReferences` emits an unnumbered, key-deduped list over the depth slice,
 * so the two never met: measured on a real `Skisse` draft the body carried `[4]`,
 * `[5]`, `[6]`, `[7]` and the paste had nothing to resolve them against. A
 * numbered source block is an invitation to write footnote numbers, so the
 * numbering is gone and the instruction below asks for the key or title in prose.
 * `c.n` still exists on the citation — it orders the stored set and the toggle
 * column — it just no longer reaches the model.
 */
export function renderJiraSources(citations: JiraCitation[]): string {
  return citations
    .map((c) => {
      const label = c.key ? `${c.key} — ${c.title}` : c.title;
      const head = `- (${c.badge}) ${label}${c.url ? ` — ${c.url}` : ""}`;
      return c.snippet ? `${head}\n${neutralizeJiraFence(c.snippet)}` : head;
    })
    .join("\n\n");
}

function renderFullDocs(docs: JiraFullDoc[]): string {
  return docs
    .map((d) => `--- ${d.title} (${d.docId}) ---\n${neutralizeJiraFence(d.text)}`)
    .join("\n\n");
}

export interface BuiltJiraPrompt {
  prompt: string;
  /** How many citations actually reached the prompt after the `JIRA_BODY_MAX`
   *  trim. Equal to `citations.length` on the ordinary path. */
  citationsUsed: number;
  /** True when the cap forced citations out. Surfaced so the caller can log it —
   *  a silently narrowed grounding set is the thing worth noticing. */
  trimmed: boolean;
}

/**
 * Assemble the user prompt.
 *
 * **The `JIRA_BODY_MAX` trim drops CITATIONS, never the raw material.** The notes
 * are the thing the reader asked to have turned into a task and are already
 * bounded by their own 400-not-truncate cap (`JIRA_NOTES_MAX`); the citations are
 * server-grown, ranked, and the tail of a ranked list is the cheapest thing in
 * the prompt to lose. Trimming the other way round would silently answer a
 * different question from the one that was asked.
 */
export function buildJiraUserPrompt(input: JiraTaskInput): BuiltJiraPrompt {
  const head = [
    neutralizeJiraFence(input.instruction.trim()),
    depthRider(input.depth),
    languageRider(),
  ];
  const extra = neutralizeJiraFence((input.extra ?? "").trim());
  if (extra) head.push(`OGSÅ FRA INNSENDEREN (følg dette også):\n${extra}`);

  const notesBlock =
    `RÅMATERIALE:\n"""\n${neutralizeJiraFence(input.notes).trim()}\n"""`;
  const fullDocsBlock = input.fullDocs?.length
    ? `HELE DOKUMENTER (utdypning av kildene over):\n"""\n${renderFullDocs(input.fullDocs)}\n"""`
    : "";

  const assemble = (cites: JiraCitation[]): string => {
    const parts = [...head];
    if (cites.length > 0) {
      parts.push(
        // NO `[n]` markers: `appendReferences` builds an UNNUMBERED, key-deduped
        // `## Referanser` over the depth slice, so a bracket number in the body
        // resolves to nothing in the Jira paste. The model names the source the
        // way a person would — "se MELOSYS-1234" — which the reference list then
        // backs with a real link.
        "KILDER (hentet fra jira-issues, melosys-confluence-v3 og nav-wiki). " +
          "Når en påstand kommer fra en kilde, nevn kilden ved navn i teksten — Jira-nøkkelen der den " +
          "finnes («se MELOSYS-1234»), ellers sidetittelen. Bruk ALDRI fotnotemarkører i klammer " +
          "(«[1]», «[2]») — de peker ikke på noe i den ferdige saken. Ikke skriv en referanseliste selv:\n" +
          `"""\n${renderJiraSources(cites)}\n"""`,
      );
      if (fullDocsBlock) parts.push(fullDocsBlock);
    } else {
      parts.push(
        "KILDER: ingen. Retrieval fant ingenting som dekker dette, så skriv saken utelukkende fra " +
          "råmaterialet under, og ikke vis til kildene eller til Jira-saker som ikke står i råmaterialet. " +
          "Ingen fotnotemarkører i klammer.",
      );
    }
    parts.push(notesBlock);
    return parts.join("\n\n");
  };

  let cites = input.citations;
  let prompt = assemble(cites);
  let trimmed = false;
  // Drop from the TAIL of the ranked list until it fits. `n` is left untouched:
  // renumbering here would desynchronise the prompt's markers from the stored
  // citation rows PR 2's toggle column renders and `## Referanser` is built from.
  while (prompt.length > JIRA_BODY_MAX && cites.length > 0) {
    cites = cites.slice(0, -1);
    prompt = assemble(cites);
    trimmed = true;
  }

  return { prompt, citationsUsed: cites.length, trimmed };
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
 * `file://./huginn-nav/wiki/…` paths, which `toJiraCitations` drops at the source.
 *
 * **It lists the citations the model was actually GIVEN — the depth slice, not
 * the whole stored set.** Measured on a real `Ingen` draft over 24 stored hits:
 * appending the stored set put 24 links under a task the model had seen 6 of, so
 * 18 of them were references to material the text does not use. PR 2's toggle
 * column still renders the full stored set — that is a different question ("what
 * could this cite?") from what the reference list answers ("what did it?").
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

