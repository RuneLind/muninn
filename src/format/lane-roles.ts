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
 *  the `WIKI_ANSWER_GROUPS` group-name grammar. */
export const ROLE_KEY_RE = /^[a-z0-9æøå_-]+$/;
/** Six digits in a row: the key could be a NAV ident (the group parser's rule). */
const DIGIT_RUN_RE = /\d{6}/;

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

interface LaneWords {
  title: string;
  /** The label of a lane with `role=` (D15). */
  label: Record<Kind, (role: string) => string>;
  /** `[one, other]` per unit. */
  units: Record<Unit, [string, string]>;
  /** The count line's phrase for one role lane. */
  sum: Record<Exclude<Kind, "blocked">, (n: string, role: string) => string>;
  blocked: (n: number) => string;
  /** The mark on the viewer's lane: «til deg» on a waiting lane, «deg» else. */
  mine: string;
  mineWaiting: string;
  /** The one-line link a `<Question>` card leaves at its authored place. */
  movedLink: (id: string) => string;
  /** «Se som rolle» (D18). */
  viewAs: string;
  viewAsSelf: string;
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
    units: { task: ["oppgave", "oppgaver"], question: ["spørsmål", "spørsmål"], draft: ["utkast", "utkast"] },
    sum: {
      waiting: (n, r) => `${n} til ${r}`,
      you: (n, r) => `${n} for ${r}`,
      draft: (n, r) => `${n} til ${r}`,
    },
    blocked: (n) => `${n} blokkert`,
    mine: "deg",
    mineWaiting: "til deg",
    movedLink: (id) => `Spørsmål ${id}: svar under Oppfølging`,
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
    units: { task: ["task", "tasks"], question: ["question", "questions"], draft: ["draft", "drafts"] },
    sum: {
      waiting: (n, r) => `${n} for ${r}`,
      you: (n, r) => `${n} for ${r}`,
      draft: (n, r) => `${n} for ${r}`,
    },
    blocked: (n) => `${n} blocked`,
    mine: "you",
    mineWaiting: "for you",
    movedLink: (id) => `Question ${id}: answer under Follow-up`,
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

/** What a lane's number counts: questions on a waiting lane naming a
 *  `<Question>`, drafts on a draft lane, tasks otherwise (D14). */
export function laneUnit(kind: Kind, hasQuestions: boolean): Unit {
  return kind === "draft" ? "draft" : kind === "waiting" && hasQuestions ? "question" : "task";
}

/** `4 spørsmål`, `1 oppgave`. */
export function laneCountText(n: number, unit: Unit, lang: QuestionLanguage | undefined): string {
  const [one, other] = laneWords(lang).units[unit];
  return `${n} ${n === 1 ? one : other}`;
}

/** One lane's phrase in the block's count line (D14): `4 spørsmål til fag`,
 *  `5 oppgaver for utvikler`, `2 blokkert`; a lane with no role reads
 *  `<label>: <n> <unit>`. */
export function laneSumPhrase(
  lane: { kind: Kind; role: string | null; label: string; count: number; unit: Unit },
  lang: QuestionLanguage | undefined,
): string {
  const w = laneWords(lang);
  if (lane.kind === "blocked") return w.blocked(lane.count);
  const n = laneCountText(lane.count, lane.unit, lang);
  return lane.role ? w.sum[lane.kind](n, lane.role) : `${lane.label}: ${n}`;
}
