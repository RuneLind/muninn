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
 * Same treatment and same rationale as `neutralizeShareFence`: keep the readable
 * content, destroy the structural marker; idempotent, since the result no longer
 * matches. Spelled locally rather than imported for the same reason it is spelled
 * locally there — those live in modules that drag whole route graphs behind them,
 * and this file is pure by contract.
 */
export function neutralizeJiraFence(text: string): string {
  return text.replace(/"{3,}/g, '"');
}

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

/** Render the numbered sources block. Our own, not `renderSourcesBlock` — the
 *  badge/key framing and the "cite with [n]" contract are this feature's. */
export function renderJiraSources(citations: JiraCitation[]): string {
  return citations
    .map((c) => {
      const label = c.key ? `${c.key} — ${c.title}` : c.title;
      const head = `[${c.n}] (${c.badge}) ${label}${c.url ? ` — ${c.url}` : ""}`;
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
        "KILDER (hentet fra jira-issues, melosys-confluence-v3 og nav-wiki). " +
          "Vis hvilken kilde en påstand kommer fra med [n] i teksten. Ikke skriv en referanseliste selv:\n" +
          `"""\n${renderJiraSources(cites)}\n"""`,
      );
      if (fullDocsBlock) parts.push(fullDocsBlock);
    } else {
      parts.push(
        "KILDER: ingen. Retrieval fant ingenting som dekker dette, så skriv saken utelukkende fra " +
          "råmaterialet under, og ikke vis til [n] eller til Jira-saker som ikke står i råmaterialet.",
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
  const lines = citations.map((c) => {
    const label = c.key ?? c.title;
    // A Jira source shows `[KEY](url) — title`; everything else `[title](url)`,
    // so the title is never printed twice.
    const tail = c.key && c.title && c.title !== c.key ? ` — ${c.title}` : "";
    return c.url ? `- [${label}](${c.url})${tail}` : `- ${label}`;
  });
  return `${markdown.trimEnd()}\n\n## Referanser\n\n${lines.join("\n")}\n`;
}

/**
 * Drop a fence that wraps the WHOLE draft.
 *
 * Every shipped template says "markdown only, no wrapping code fence", and a
 * model that ignores it does not produce a slightly-off task — it produces a task
 * that pastes into Jira as one syntax-highlighted code block with the markdown
 * showing. Cheaper to undo here than to explain.
 *
 * Deliberately narrow, and the interior check is what makes "first line + last
 * line" mean "ONE fence": the outer match is greedy by construction, so a draft
 * that merely BEGINS and ENDS with a code block would otherwise have both of its
 * real fences stripped and its prose spliced into code. A run of the same marker
 * at the start of an interior line, at least as long as the opener, disqualifies
 * the match. Same shape and same tradeoff as `stripWrappingFence` in
 * `src/share/prompt.ts` — under-stripping costs one visible fence the reader can
 * delete, over-stripping silently corrupts the task.
 */
export function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  const m = /^(`{3,}|~{3,})[ \t]*\r?\n([\s\S]*)\r?\n\1[ \t]*$/.exec(trimmed);
  if (!m) return trimmed;
  const marker = m[1]!;
  const interior = m[2]!;
  const innerCloser = new RegExp(`(?:^|\\n)[ \\t]{0,3}[${marker[0]}]{${marker.length},}`);
  if (innerCloser.test(interior)) return trimmed;
  return interior.trim();
}
