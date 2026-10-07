/**
 * The words an answer card shows, in the wiki's language (`.wiki-reader.json`
 * `language`: `en` or `no`, default `en`). Dependency-free and browser-safe:
 * the server renders the read-only card from it, and the reader's client
 * (answer cards PR 3) imports the same table for the composer and the export
 * button, so the two cannot spell one state two ways.
 */

export const QUESTION_LANGUAGES = ["en", "no"] as const;
export type QuestionLanguage = (typeof QUESTION_LANGUAGES)[number];
export const DEFAULT_QUESTION_LANGUAGE: QuestionLanguage = "en";

export interface QuestionLabels {
  /** The card's lead word. */
  question: string;
  /** Card states (the plan's state table). */
  open: string;
  answered: string;
  copied: string;
  /** `Decided → D99`: the state word; the arrow and the id follow it. */
  decided: string;
  closed: string;
  /** Lead of the line naming who the question is for. */
  for: string;
  /** An answer from a person the page asked, or from someone else (D2). */
  asked: string;
  notAsked: string;
  /** The fixed extra choice every card with `choices` offers. */
  notSure: string;
  copyNew: (n: number) => string;
  copyAgain: string;
  edited: (n: number) => string;
  /** Badge on a closed card holding answers not yet copied. */
  newBadge: (n: number) => string;
  /** A `<Question>` with no `id`. */
  noId: string;
  /** A `<Question>` whose id another `<Question>` on the page also uses. */
  duplicate: string;
}

export const QUESTION_LABELS: Record<QuestionLanguage, QuestionLabels> = {
  en: {
    question: "Question",
    open: "Open",
    answered: "Answered",
    copied: "Copied",
    decided: "Decided",
    closed: "Closed",
    for: "For",
    asked: "asked",
    notAsked: "not asked",
    notSure: "Not sure yet",
    copyNew: (n) => `Copy new answers (${n})`,
    copyAgain: "Copy again",
    edited: (n) => `edited ${n}×`,
    newBadge: (n) => `${n} new`,
    noId: "Question without id",
    duplicate: "Another question on this page uses this id.",
  },
  no: {
    question: "Spørsmål",
    open: "Åpent",
    answered: "Besvart",
    copied: "Kopiert",
    decided: "Avgjort",
    closed: "Lukket",
    for: "Stilt til",
    asked: "spurt",
    notAsked: "ikke spurt",
    notSure: "Vet ikke ennå",
    copyNew: (n) => `Kopier nye svar (${n})`,
    copyAgain: "Kopier igjen",
    edited: (n) => `endret ${n}×`,
    newBadge: (n) => `${n} nye`,
    noId: "Spørsmål uten id",
    duplicate: "Et annet spørsmål på siden bruker samme id.",
  },
};

export function questionLabels(language: QuestionLanguage | undefined): QuestionLabels {
  return QUESTION_LABELS[language ?? DEFAULT_QUESTION_LANGUAGE];
}

/**
 * The `.wiki-reader.json` `language` key: `en` or `no`, trimmed and
 * case-folded. Absent ⇒ the default with no warning; anything else ⇒ the
 * default plus a warning naming the value, the reader-config convention.
 */
export function parseQuestionLanguage(raw: unknown): { language: QuestionLanguage; warning?: string } {
  if (raw === undefined) return { language: DEFAULT_QUESTION_LANGUAGE };
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if ((QUESTION_LANGUAGES as readonly string[]).includes(v)) return { language: v as QuestionLanguage };
  }
  return {
    language: DEFAULT_QUESTION_LANGUAGE,
    warning: `is not one of ${QUESTION_LANGUAGES.join(", ")} (got ${JSON.stringify(raw)}) — using ${DEFAULT_QUESTION_LANGUAGE}`,
  };
}
