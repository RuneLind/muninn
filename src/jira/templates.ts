/**
 * Jira task templates — the instruction that shapes one drafted task.
 *
 * The default set SHIPS IN THIS REPO as typed constants, for the same reason
 * `src/share/presets.ts` does: `bots/*` is gitignored and synced from
 * `muninn-config`, so a per-bot-only feature would be dead on every bot until
 * someone edits the other repo.
 *
 * Per-bot files layer on top by id — `bots/<name>/prompts/jiraTemplate.<id>.md`
 * overrides a shipped template of the same id or appends a new one. The loader
 * (`src/bots/config.ts`) only DISCOVERS those files; the merge lives here.
 *
 * **The shipped set is an ordered ARRAY, not a record.** The variant loader sorts
 * discovered ids with `localeCompare`, so a record keyed by id would render PR 2's
 * picker as `bug, spike, story, task` — alphabetical, not the order a human picks
 * in. Order is a contract here, exactly as it is in `SHARE_LANGS`.
 *
 * Pure + IO-free: `BotPrompts` is imported as a TYPE ONLY, which under
 * `verbatimModuleSyntax` is what keeps `bots/config.ts`'s `node:fs`/db graph out
 * of this module (the `presets.ts` measurement: ~2ms → ~20ms with a value import).
 */

import type { BotPrompts } from "../bots/config.ts";
import type { JiraTemplateId } from "./wire.ts";

/** One resolved template the picker offers and the drafting service runs. */
export interface JiraTemplate {
  id: string;
  label: string;
  content: string;
}

// ── Rules every shipped template carries ─────────────────────────────────────
// Composed from ONE constant, but interpolated into each template so the rules
// appear VERBATIM in every rendered prompt — a per-bot override copied out of the
// picker takes the whole contract with it. The four that are not style preference:
//
//   * the MEASURED markdown subset (PR 0, in a live MELOSYS create screen). Task
//     lists and emoji shortcodes are excluded because they do NOT convert on
//     paste; HTML and wiki markup because they arrive as visible garbage.
//   * no invented Jira keys. The whole feature is defended against exactly this,
//     and `verify-keys.ts` is the mechanical half — this is the cheap half.
//   * no derived quantities. The task is filed under the reader's name.
//   * no `## Referanser` section. The SERVER appends it deterministically from the
//     retained citations, so every link resolves by construction. A model-written
//     one would be the fabricated-key surface all over again.

const SHARED_TEMPLATE_RULES = `Regler:
- Skriv KUN markdown, i denne målte delmengden: overskrifter (#–####), **fet**, *kursiv*, punktlister med \`-\`, nummererte lister, inntil tre nivåer nesting, kodegjerder MED språktag, pipe-tabeller, [tekst](url), > sitat, --- skillelinje.
- ALDRI: HTML-tagger, Jira wiki-markup (h2., {code}, {panel}), avkryssingsbokser (\`- [ ]\`) eller emoji-koder (\`:warning:\`). De konverteres ikke ved innliming og blir stående som synlig søppel. Akseptansekriterier skrives som vanlige punkter.
- Nevn aldri en Jira-nøkkel som ikke står i kildene eller i råmaterialet. Ingen oppdiktede saksnumre.
- Ingen tall, prosenter eller datoer som ikke står i kilden. Ikke regn ut, summer eller anslå.
- Ikke skriv en «## Referanser»-seksjon — den legges på automatisk.
- Svar med selve oppgaveteksten og ingenting annet. Ingen innledning, ingen kommentar til oppgaven.`;

export const BUG_TEMPLATE = `Skriv en BUG-sak fra råmaterialet nedenfor.

Struktur:
- \`## Symptom\` — hva brukeren faktisk observerer, konkret og først. Ikke årsak.
- \`## Slik reproduseres det\` — nummererte steg hvis råmaterialet gir dem, ellers en setning om hva som utløser feilen.
- \`## Forventet vs. faktisk\` — to korte punkter.
- \`## Hypotese\` — KUN hvis råmaterialet eller kildene gir grunnlag, og merk den eksplisitt som hypotese ("Hypotese:"). Utelat seksjonen helt hvis du ikke har noe.
- \`## Akseptansekriterier\` — vanlige punkter (ikke avkryssingsbokser), ett per verifiserbart utfall.

${SHARED_TEMPLATE_RULES}`;

export const STORY_TEMPLATE = `Skriv en STORY fra råmaterialet nedenfor.

Struktur:
- \`## Verdi\` — hvem får hva, og hvorfor det er verdt å gjøre nå. To–tre setninger.
- \`## Omfang\` — hva som er innenfor, og hvis råmaterialet sier det: hva som er utenfor.
- \`## Akseptansekriterier\` — vanlige punkter (ikke avkryssingsbokser), formulert som observerbare utfall, ikke som oppgaver.
- \`## Åpne spørsmål\` — kun hvis råmaterialet etterlater reelle avklaringer.

${SHARED_TEMPLATE_RULES}`;

export const TASK_TEMPLATE = `Skriv en TASK (teknisk arbeid) fra råmaterialet nedenfor.

Struktur:
- \`## Problem\` — den tekniske situasjonen som skal endres.
- \`## Hvorfor nå\` — hva som gjør dette presserende eller mulig akkurat nå.
- \`## Definition of done\` — vanlige punkter (ikke avkryssingsbokser), hvert punkt etterprøvbart.

${SHARED_TEMPLATE_RULES}`;

export const SPIKE_TEMPLATE = `Skriv en SPIKE fra råmaterialet nedenfor.

Struktur:
- \`## Spørsmål\` — HØYST tre spørsmål, som punkter. Færre er bedre.
- \`## Tidsboks\` — foreslå en tidsboks i dager, og si hva den bygger på.
- \`## Beslutningspunkt\` — hva vi skal kunne bestemme når spiken er over, og hvem som bestemmer hvis råmaterialet sier det.
- \`## Slik ser vi at vi er ferdige\` — vanlige punkter.

${SHARED_TEMPLATE_RULES}`;

/**
 * The shipped set, in PICKER ORDER. `bug` first because it is the acceptance
 * test's template and the commonest refinement output.
 */
export const SHIPPED_JIRA_TEMPLATES: readonly JiraTemplate[] = [
  { id: "bug" satisfies JiraTemplateId, label: "Bug", content: BUG_TEMPLATE },
  { id: "story" satisfies JiraTemplateId, label: "Story", content: STORY_TEMPLATE },
  { id: "task" satisfies JiraTemplateId, label: "Task", content: TASK_TEMPLATE },
  { id: "spike" satisfies JiraTemplateId, label: "Spike", content: SPIKE_TEMPLATE },
];

/**
 * Resolve the templates a given bot offers: the shipped set with any per-bot
 * `jiraTemplate.<id>.md` of the same id REPLACING it IN PLACE, then the bot's
 * remaining new ids appended in the loader's (sorted) order.
 *
 * In-place override matters for the reason it does in `resolveSharePresets`: a
 * bot that rewrites `bug` must not end up offering two entries labelled Bug,
 * where which one runs depends on picker order.
 *
 * BLANK IS ABSENT at this layer too. The loader already drops an empty variant
 * file, but a guard that lives only in the loader is a guard on one caller: any
 * other producer of a `BotPrompts` (a test, a future DB-backed prompt source)
 * handing over `"  \n "` would replace a shipped template with an
 * instruction-free prompt and file whatever the model made of a bare note.
 *
 * There is deliberately NO synthetic `default` entry (the share layer's shape):
 * `jiraTemplate` is not in `SINGLE_PROMPT_KEYS`, so a bare `jiraTemplate.md`
 * never loads and there is nothing for a default entry to point at.
 */
export function resolveJiraTemplates(prompts: BotPrompts | undefined): JiraTemplate[] {
  const overrides = new Map<string, JiraTemplate>();
  for (const v of prompts?.jiraTemplateVariants ?? []) {
    if (v.content.trim() === "") continue;
    overrides.set(v.id, { id: v.id, label: v.label, content: v.content });
  }

  const resolved: JiraTemplate[] = [];
  for (const shipped of SHIPPED_JIRA_TEMPLATES) {
    const override = overrides.get(shipped.id);
    resolved.push(override ?? shipped);
    overrides.delete(shipped.id);
  }
  for (const extra of overrides.values()) resolved.push(extra);
  return resolved;
}

/**
 * Look one template up by id.
 *
 * An unknown id returns **undefined** so the route can 400 naming it, rather than
 * falling back to `bug` and generating with the wrong instruction — the reader
 * would have no way to see which shape produced the task they are about to file.
 * The `findSharePreset` rule, minus its absent-id default: there is no "no
 * preference" answer here, the picker always has a selection.
 */
export function findJiraTemplate(
  templates: JiraTemplate[],
  id: string | undefined,
): JiraTemplate | undefined {
  const wanted = id?.trim();
  if (!wanted) return undefined;
  return templates.find((t) => t.id === wanted);
}
