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
  /** The button that copies the wiki's orphaned answers (O4). */
  copyOrphans: (n: number) => string;
  /** The export button's status line (answer cards PR 4). */
  exportStatus: {
    /** The answers changed since the block was fetched: a fresh one is loading. */
    stale: string;
    copied: (n: number) => string;
    copiedAgain: (n: number) => string;
    copyFailed: string;
    /** The clipboard write worked, the confirm did not: nothing is marked. */
    confirmFailed: string;
    loadFailed: string;
    /** Copied orphaned answers: answers in this wiki whose page or question is gone (O4). */
    copiedOrphans: (n: number) => string;
    /** The orphan button's tooltip. */
    orphansTitle: string;
  };
  edited: (n: number) => string;
  /** Badge on a closed card holding answers not yet copied. */
  newBadge: (n: number) => string;
  /** A `<Question>` with no `id`. */
  noId: string;
  /** A `<Question>` whose id another `<Question>` on the page also uses. */
  duplicate: string;
  /** The composer (answer cards PR 3). */
  composer: {
    choices: string;
    answer: string;
    placeholder: string;
    save: string;
    saveEdit: string;
    saving: string;
    edit: string;
    cancel: string;
    /** A 409 version_conflict: someone saved a newer version first. The
     *  reader's text stays in the editor, now based on that newer version. */
    conflict: string;
    /** The answer being edited is gone (deleted by the retention sweep): the
     *  reader's text is kept in the composer as a new answer. */
    editGone: string;
    failed: string;
    loadFailed: string;
    /** The POST succeeded, the reload of the answers did not. */
    savedReloadFailed: string;
    /** Button that loads the answers again. */
    retry: string;
    /** Button that clears the picked choice. */
    clearChoice: string;
    /** Why Save is disabled: the body is `n` characters over the cap. */
    overCap: (n: number) => string;
    /** The answer scanner refused the text; its reasons follow. */
    scannerRefused: string;
    /** The scanner refused the text and gave no reason. */
    scannerRefusedNone: string;
    /** After the reasons shown: how many more the server left out. */
    moreReasons: (n: number) => string;
    /** No answer scanner could run, and this server needs one. */
    scannerUnavailable: string;
  };
  /** An admin's Redact control on each answer, with its inline confirm (PR 5). */
  redact: {
    open: string;
    prompt: string;
    confirm: string;
    cancel: string;
    working: string;
    failed: string;
    /** Why a redact failed: a role refusal (403), the origin guard (403),
     *  no such answer (404), no answer at all. */
    forbidden: string;
    origin: string;
    gone: string;
    network: string;
    /** Any other status. */
    http: (status: number) => string;
    /** The redact landed; the reload after it did not. */
    reloadFailed: string;
  };
  redacted: string;
  /** The log fold: an answer's earlier versions. */
  earlier: (n: number) => string;
  version: (n: number) => string;
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
    copyOrphans: (n) => `Copy orphaned answers (${n})`,
    exportStatus: {
      stale: "The answers changed. Loading the new ones; click again.",
      copied: (n) => `Copied ${n} ${n === 1 ? "answer" : "answers"}.`,
      copiedAgain: (n) => `Copied ${n} ${n === 1 ? "answer" : "answers"} again.`,
      copyFailed: "Could not copy to the clipboard. Nothing was marked as copied.",
      confirmFailed: "Copied, but the answers could not be marked as copied. Click again to retry.",
      loadFailed: "The answers to copy could not be loaded.",
      copiedOrphans: (n) => `Copied ${n} orphaned ${n === 1 ? "answer" : "answers"}.`,
      orphansTitle: "Answers in this wiki, not copied yet, whose page or question is gone",
    },
    edited: (n) => `edited ${n}×`,
    newBadge: (n) => `${n} new`,
    noId: "Question without id",
    duplicate: "Another question on this page uses this id.",
    composer: {
      choices: "Choice",
      answer: "Your answer",
      placeholder: "Your answer …",
      save: "Save answer",
      saveEdit: "Save change",
      saving: "Saving …",
      edit: "Edit",
      cancel: "Cancel",
      conflict:
        "This answer changed somewhere else. The latest version is shown above; your text is still in the editor, and saving it replaces that version.",
      editGone: "The answer you were editing was removed. Your text is kept below; saving it adds it as a new answer.",
      failed: "The answer was not saved",
      loadFailed: "Answers could not be loaded.",
      savedReloadFailed: "The answer was saved, but the answers could not be loaded again.",
      retry: "Load again",
      clearChoice: "Clear choice",
      overCap: (n) => `Too long: remove ${n} ${n === 1 ? "character" : "characters"} to save.`,
      scannerRefused: "The answer was not saved. The scanner flagged:",
      scannerRefusedNone: "The answer was not saved: the scanner flagged it.",
      moreReasons: (n) => `(+${n} more)`,
      scannerUnavailable: "The answer was not saved: this server has no answer scanner available.",
    },
    redact: {
      open: "Redact…",
      prompt: "Empty this answer's text and choice in every version? This cannot be undone.",
      confirm: "Redact",
      cancel: "Cancel",
      working: "Redacting …",
      failed: "The answer was not redacted",
      forbidden: "The answer was not redacted: you may not redact answers.",
      origin: "The answer was not redacted: the server refused a request from this page's address.",
      gone: "The answer was not redacted: the answer no longer exists.",
      network: "The answer was not redacted: could not reach the server.",
      http: (status) => `The answer was not redacted (HTTP ${status}).`,
      reloadFailed: "The answer was redacted, but the answers could not be loaded again.",
    },
    redacted: "redacted",
    earlier: (n) => `Earlier versions (${n})`,
    version: (n) => `version ${n}`,
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
    copyOrphans: (n) => `Kopier foreldreløse svar (${n})`,
    exportStatus: {
      stale: "Svarene er endret. Henter de nye; klikk igjen.",
      copied: (n) => `Kopierte ${n} svar.`,
      copiedAgain: (n) => `Kopierte ${n} svar på nytt.`,
      copyFailed: "Kunne ikke kopiere til utklippstavlen. Ingenting ble merket som kopiert.",
      confirmFailed: "Kopiert, men svarene kunne ikke merkes som kopiert. Klikk igjen for å prøve på nytt.",
      loadFailed: "Kunne ikke hente svarene som skal kopieres.",
      copiedOrphans: (n) => `Kopierte ${n} foreldreløse svar.`,
      orphansTitle: "Svar i denne wikien, ikke kopiert ennå, der siden eller spørsmålet er borte",
    },
    edited: (n) => `endret ${n}×`,
    newBadge: (n) => `${n} nye`,
    noId: "Spørsmål uten id",
    duplicate: "Et annet spørsmål på siden bruker samme id.",
    composer: {
      choices: "Valg",
      answer: "Svaret ditt",
      placeholder: "Svaret ditt …",
      save: "Lagre svar",
      saveEdit: "Lagre endring",
      saving: "Lagrer …",
      edit: "Endre",
      cancel: "Avbryt",
      conflict:
        "Svaret er endret et annet sted. Den nyeste versjonen vises over; teksten din står fortsatt i feltet, og lagrer du den, erstatter den den versjonen.",
      editGone: "Svaret du endret er fjernet. Teksten din er beholdt nedenfor; lagrer du den, blir den et nytt svar.",
      failed: "Svaret ble ikke lagret",
      loadFailed: "Kunne ikke hente svarene.",
      savedReloadFailed: "Svaret ble lagret, men svarene kunne ikke hentes på nytt.",
      retry: "Hent på nytt",
      clearChoice: "Fjern valg",
      overCap: (n) => `For langt: fjern ${n} tegn for å lagre.`,
      scannerRefused: "Svaret ble ikke lagret. Skanneren fant:",
      scannerRefusedNone: "Svaret ble ikke lagret: skanneren stoppet det.",
      moreReasons: (n) => `(+${n} til)`,
      scannerUnavailable: "Svaret ble ikke lagret: serveren har ingen svarskanner tilgjengelig.",
    },
    redact: {
      open: "Fjern…",
      prompt: "Tømme teksten og valget i alle versjoner av dette svaret? Det kan ikke angres.",
      confirm: "Fjern",
      cancel: "Avbryt",
      working: "Fjerner …",
      failed: "Svaret ble ikke fjernet",
      forbidden: "Svaret ble ikke fjernet: du har ikke lov til å fjerne svar.",
      origin: "Svaret ble ikke fjernet: serveren avviste en forespørsel fra denne sidens adresse.",
      gone: "Svaret ble ikke fjernet: svaret finnes ikke lenger.",
      network: "Svaret ble ikke fjernet: fikk ikke kontakt med serveren.",
      http: (status) => `Svaret ble ikke fjernet (HTTP ${status}).`,
      reloadFailed: "Svaret ble fjernet, men svarene kunne ikke hentes på nytt.",
    },
    redacted: "fjernet",
    earlier: (n) => `Tidligere versjoner (${n})`,
    version: (n) => `versjon ${n}`,
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
