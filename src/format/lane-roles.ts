/**
 * Role-named lanes (`<Lane role="fag">`, D15, D30, D32): the label a lane
 * reads by, the «Oppfølging» block's words, and the `.wiki-reader.json`
 * `roleKeys` list. Dependency-free and browser-safe: the server renders the
 * block from it and the reader's client marks the viewer's lanes with the same
 * table.
 *
 * A role is a `WIKI_ANSWER_GROUPS` key. Membership never leaves the server;
 * `roleKeys` names the keys only, with no members and no idents.
 */

import type { QuestionLanguage } from "./question-labels.ts";

/** A role key as `roleKeys` and `<Lane role=>` take it, after lower-casing —
 *  the `WIKI_ANSWER_GROUPS` group-name grammar (`parseAnswerGroups` in
 *  `src/config.ts` reads this one copy). */
export const ROLE_KEY_RE = /^[a-z0-9æøå_-]+$/;
/** Six or more digits in a row, anywhere in the name. A NAV ident is a letter
 *  and six digits, so a name holding one (`fag-z990001`, garbled `z9900011`)
 *  would put an ident on every chip and export heading. The rule ignores the
 *  letter on purpose: it refuses a week-coded `uke202541` too, which an
 *  operator writes `uke2025-41`, and leaves no letter class to get wrong. */
export const DIGIT_RUN_RE = /\d{6}/;

/** A `role=` value or a `roleKeys` entry as one key: trimmed, lower-cased.
 *  Null when it is empty or not a key. */
export function normalizeRoleKey(value: string | undefined): string | null {
  const k = value?.trim().toLowerCase() ?? "";
  return k && ROLE_KEY_RE.test(k) && !DIGIT_RUN_RE.test(k) ? k : null;
}

/** `.wiki-reader.json` `roleKeys`: a list of role keys. A bad entry is dropped
 *  with a warning; a value that is not an array drops the key. */
export function parseRoleKeys(value: unknown): { keys: string[]; warnings: string[] } {
  if (value === undefined) return { keys: [], warnings: [] };
  if (!Array.isArray(value)) return { keys: [], warnings: ["is not an array of role keys — ignoring it"] };
  const keys: string[] = [];
  const warnings: string[] = [];
  value.forEach((v, i) => {
    const k = typeof v === "string" ? normalizeRoleKey(v) : null;
    if (k === null) {
      warnings.push(`entry ${i + 1} dropped: a role key is letters, digits, "_" or "-", with no six-digit run`);
    } else if (!keys.includes(k)) keys.push(k);
  });
  return { keys, warnings };
}

type Kind = "you" | "waiting" | "draft" | "blocked";
type Unit = "task" | "question" | "draft";

/** One part of a lane's count: `2 spørsmål`, `1 oppgave`. A waiting lane that
 *  names `<Question>` cards has two parts; every other lane has one. */
export interface LaneCount {
  n: number;
  unit: Unit;
}

interface LaneWords {
  title: string;
  /** The label of a lane with `role=` (D15). */
  label: Record<Kind, (role: string) => string>;
  /** The label of a lane with neither `role=` nor `who=`, on the reader.
   *  Null ⇒ `LANE_DEFAULT_LABEL` (English, what every other surface shows). */
  defaults: Record<Kind, string> | null;
  /** Joins the parts of a count: «2 spørsmål og 1 oppgave». */
  and: string;
  /** `[one, other]` per unit. */
  units: Record<Unit, [string, string]>;
  /** The count line's phrase for one role lane. */
  sum: Record<Exclude<Kind, "blocked">, (n: string, role: string) => string>;
  blocked: (n: number) => string;
  /** The mark on the viewer's lane: «til deg» on a waiting lane, «deg» else. */
  mine: string;
  mineWaiting: string;
  /** The one line a run of moved `<Question>` cards leaves at its authored
   *  place (D39): «Spørsmål S2, S6 og S7 står under Oppfølging ↑». `arrow` is
   *  ↑ when the block sits above the line, ↓ when below. */
  movedLink: (ids: readonly string[], arrow: "↑" | "↓") => string;
  /** A lane head's age (D37): «stilt 07.10 · 3 d» on a waiting lane, «siden
   *  07.10 · 3 d» elsewhere. */
  age: (waiting: boolean, date: string, days: number) => string;
  /** The chip on each open step of a draft lane: «ikke sendt · 3 d». */
  notSent: (days: number) => string;
  drafted: (date: string) => string;
  /** A waiting lane's progress over the cards it names (D38). */
  progress: (answered: number, of: number) => string;
  /** The action at the end of a lane head (D38). */
  action: { answer: string; questions: string; see: string; seeAll: string; hide: string };
  /** «Se som rolle» (D18). */
  viewAs: string;
  viewAsSelf: string;
}

/** `S2`, `S2 og S6`, `S2, S6 og S7`. */
function listIds(ids: readonly string[], and: string): string {
  return ids.length <= 1 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} ${and} ${ids[ids.length - 1]}`;
}

const capitalize = (s: string) => (s ? s[0]!.toLocaleUpperCase() + s.slice(1) : s);

const WORDS: Record<QuestionLanguage, LaneWords> = {
  no: {
    title: "Oppfølging",
    label: {
      waiting: (r) => `Venter på ${r}`,
      you: (r) => capitalize(r),
      draft: (r) => `Utkast til ${r}`,
      blocked: () => "Blokkert",
    },
    defaults: { you: "Du", waiting: "Venter", draft: "Utkast", blocked: "Blokkert" },
    and: "og",
    units: { task: ["oppgave", "oppgaver"], question: ["spørsmål", "spørsmål"], draft: ["utkast", "utkast"] },
    sum: {
      waiting: (n, r) => `${n} til ${r}`,
      you: (n, r) => `${n} for ${r}`,
      draft: (n, r) => `${n} til ${r}`,
    },
    blocked: (n) => `${n} blokkert`,
    mine: "deg",
    mineWaiting: "til deg",
    movedLink: (ids, arrow) => `Spørsmål ${listIds(ids, WORDS.no.and)} står under Oppfølging ${arrow}`,
    age: (waiting, date, days) => `${waiting ? "stilt" : "siden"} ${date} · ${days} d`,
    notSent: (days) => `ikke sendt · ${days} d`,
    drafted: (date) => `utkast ${date}`,
    progress: (n, of) => `${n} av ${of} besvart`,
    action: { answer: "Se og svar ▸", questions: "Se spørsmålene ▸", see: "Se ▸", seeAll: "Se alle ▸", hide: "Skjul ▴" },
    viewAs: "Se som rolle",
    viewAsSelf: "min visning",
  },
  en: {
    title: "Follow-up",
    label: {
      waiting: (r) => `Waiting on ${r}`,
      you: (r) => capitalize(r),
      draft: (r) => `Draft for ${r}`,
      blocked: () => "Blocked",
    },
    defaults: null,
    and: "and",
    units: { task: ["task", "tasks"], question: ["question", "questions"], draft: ["draft", "drafts"] },
    sum: {
      waiting: (n, r) => `${n} for ${r}`,
      you: (n, r) => `${n} for ${r}`,
      draft: (n, r) => `${n} for ${r}`,
    },
    blocked: (n) => `${n} blocked`,
    mine: "you",
    mineWaiting: "for you",
    movedLink: (ids, arrow) =>
      ids.length === 1 ? `Question ${ids[0]} is under Follow-up ${arrow}` : `Questions ${listIds(ids, WORDS.en.and)} are under Follow-up ${arrow}`,
    age: (waiting, date, days) => `${waiting ? "asked" : "since"} ${date} · ${days} d`,
    notSent: (days) => `not sent · ${days} d`,
    drafted: (date) => `drafted ${date}`,
    progress: (n, of) => `${n} of ${of} answered`,
    action: { answer: "Answer ▸", questions: "See questions ▸", see: "See ▸", seeAll: "See all ▸", hide: "Hide ▴" },
    viewAs: "View as role",
    viewAsSelf: "my view",
  },
};

export function laneWords(lang: QuestionLanguage | undefined): LaneWords {
  return WORDS[lang ?? "en"] ?? WORDS.en;
}

/** A role lane's label (D15): «Venter på fag», «Utvikler», «Blokkert». */
export function roleLaneLabel(kind: Kind, role: string, lang: QuestionLanguage | undefined): string {
  return laneWords(lang).label[kind](role);
}

/** The label of a lane with neither `role=` nor `who=` in the wiki's
 *  language («Du», «Venter»), or null where the English default applies. */
export function laneDefaultLabel(kind: Kind, lang: QuestionLanguage | undefined): string | null {
  return laneWords(lang).defaults?.[kind] ?? null;
}

/** What a lane's number counts when it names no `<Question>`: drafts on a
 *  draft lane, tasks otherwise (D14). */
export function laneUnit(kind: Kind): Unit {
  return kind === "draft" ? "draft" : "task";
}

/** `4 spørsmål`, `1 oppgave`, `2 spørsmål og 1 oppgave`. Parts with no count
 *  are left out; all of them empty reads as the first part's zero. */
export function laneCountText(counts: readonly LaneCount[], lang: QuestionLanguage | undefined): string {
  const w = laneWords(lang);
  const one = ({ n, unit }: LaneCount) => {
    const [singular, plural] = w.units[unit];
    return `${n} ${n === 1 ? singular : plural}`;
  };
  const parts = counts.filter((c) => c.n > 0);
  return parts.length ? parts.map(one).join(` ${w.and} `) : one(counts[0] ?? { n: 0, unit: "task" });
}

/** One lane's phrase in the block's count line (D14): `4 spørsmål til fag`,
 *  `2 spørsmål og 1 oppgave til fag`, `5 oppgaver for utvikler`, `2 blokkert`;
 *  a lane with no role reads `<label>: <count>`. */
export function laneSumPhrase(
  lane: { kind: Kind; role: string | null; label: string; counts: readonly LaneCount[] },
  lang: QuestionLanguage | undefined,
): string {
  const w = laneWords(lang);
  if (lane.kind === "blocked") return w.blocked(lane.counts.reduce((sum, c) => sum + c.n, 0));
  const n = laneCountText(lane.counts, lang);
  return lane.role ? w.sum[lane.kind](n, lane.role) : `${lane.label}: ${n}`;
}
