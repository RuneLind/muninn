/**
 * The status date check in the article head (mimir plan
 * muninn-wiki-first-screen-claims, P3): one line beside the Stale check's pill
 * that says what `GET /api/wiki/claim-check` compared for the open page and
 * what it found. The wording is pure; {@link makeStatusDateLoader} holds the
 * open page's answer and its request for `wiki-stale-controller.ts`, which
 * paints.
 *
 * Every line names the comparison (the page's `status_date` against the
 * newest merge among its `prs:`), so none reads as a verdict on the page: the
 * check compares two dates and reads no status line. There is no line where
 * nothing was compared and the page gives nothing to compare: no `prs:`, a
 * page the check does not read (`not-live`), a request that failed, a verdict
 * or reason this file does not know.
 */
import { escHtml as esc } from "./escape.ts";

/** The route's answer as the line reads it (`StatusDateBody` in `src/wiki/status-date-check.ts`). */
export interface StatusDateView {
  verdict?: string;
  statusDate?: string;
  newest?: { pr?: string; repo?: string; n?: number; mergedDay?: string };
  reason?: string;
  repos?: string[];
  unreadable?: string[];
  error?: string;
}

export interface StatusDateLine {
  tone: "late" | "clear" | "unchecked";
  text: string;
  /** The hover text: the two dates in full, or why nothing was compared. */
  title: string;
}

const COMPARES = "The check compares these two dates and reads no status line.";

/** `DD.MM` of a `YYYY-MM-DD` day, "" for anything else. */
function dayMonth(day: string | undefined): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day ?? "");
  return m ? `${m[2]}.${m[1]}` : "";
}

/** `repo#n, DD.MM`: the merge the answer names, its repo without the owner. */
function mergeLabel(n: NonNullable<StatusDateView["newest"]>): string {
  const repo = (n.repo ?? "").split("/").pop() ?? "";
  const pr = repo && n.n ? `${repo}#${n.n}` : (n.pr ?? "");
  return [pr, dayMonth(n.mergedDay)].filter(Boolean).join(", ");
}

const list = (xs: string[] | undefined): string => (xs ?? []).filter((x) => typeof x === "string" && x).join(", ");

/** Why nothing was compared, per reason the line speaks for. `no-prs` and `not-live` are not here: no line. */
function notCheckedLine(v: StatusDateView): { text: string; title: string } | null {
  switch (v.reason) {
    case "not-asked":
      return {
        text: "status date not checked: no PR state on hand",
        title: "No state under an hour old is on hand for at least one of this page's PRs. Where the work map card's check runs, it asks GitHub; this line only reads what that check got, when the page loads.",
      };
    case "auth": {
      const repos = list(v.repos);
      return { text: "status date not checked: no GitHub access", title: `The gh command here is not logged in, or its login cannot read ${repos || "a repo in the page's prs:"}.` };
    }
    case "no-gh":
      return { text: "status date not checked: no gh command", title: "The gh command is not installed where muninn runs, so GitHub was not asked." };
    case "unreadable-prs": {
      const entries = list(v.unreadable);
      return { text: "status date not checked: prs: holds an entry that is no PR", title: entries ? `Not a PR reference: ${entries}.` : "An entry in the page's prs: is not a PR reference." };
    }
    case "no-status-date":
      return { text: "status date not checked: the page has no status_date", title: "The page lists PRs in prs: but has no status_date to compare with their merges." };
    default:
      return null;
  }
}

/** The line for one answer, or null where the head says nothing. */
export function statusDateLine(v: StatusDateView | null | undefined): StatusDateLine | null {
  if (!v || v.error) return null;
  if (v.verdict === "late" && v.newest && v.statusDate) {
    const label = mergeLabel(v.newest);
    return {
      tone: "late",
      // «a merged PR», not «its last»: a later merge is `late` whatever the page's other PRs are, also ones with no state on hand.
      text: `⚠ status older than a merged PR${label ? ` (${label})` : ""}`,
      title: `status_date ${v.statusDate} is older than a merge among the page's prs: ${v.newest.pr ?? ""}, merged ${v.newest.mergedDay ?? ""}. ${COMPARES}`,
    };
  }
  if (v.verdict === "clear" && v.statusDate) {
    const label = v.newest ? mergeLabel(v.newest) : "";
    if (!v.newest) {
      return { tone: "clear", text: "status date checked: no merged PR in prs:", title: `status_date ${v.statusDate}; none of the PRs in the page's prs: is merged. ${COMPARES}` };
    }
    return {
      tone: "clear",
      text: `status dated on or after its last merged PR${label ? ` (${label})` : ""}`,
      title: `status_date ${v.statusDate} is not older than the newest merge among the page's prs: ${v.newest.pr ?? ""}, merged ${v.newest.mergedDay ?? ""}. ${COMPARES}`,
    };
  }
  if (v.verdict === "notChecked") {
    const line = notCheckedLine(v);
    return line ? { tone: "unchecked", ...line } : null;
  }
  return null;
}

/** The line as it sits in the pill slot, after the Stale check's pill; "" for no line. */
export function statusDatePillHtml(v: StatusDateView | null | undefined): string {
  const l = statusDateLine(v);
  if (!l) return "";
  return `<span class="wiki-status-date ${l.tone}" data-status-date="${l.tone}" title="${esc(l.title)}">${esc(l.text)}</span>`;
}

/** The check's URL for a page, or null where the route would refuse: it needs
 *  the wiki's name and answers only for `.md`/`.mdx` pages. */
export function claimCheckUrl(wiki: string, relPath: string): string | null {
  if (!wiki || !/\.mdx?$/i.test(relPath)) return null;
  return `/api/wiki/claim-check?wiki=${encodeURIComponent(wiki)}&relPath=${encodeURIComponent(relPath)}`;
}

/**
 * The open page's answer and the request behind it. `load` moves to a page,
 * forgets the last page's answer at once and asks. An answer is kept when it
 * is the newest request's and its page is still the loader's; `answerFor`
 * gives it for that page alone. A request that fails or is refused leaves no
 * answer, so no line.
 */
export function makeStatusDateLoader(io: { wiki: () => string; onAnswer: () => void; fetch?: typeof fetch }) {
  let page: string | null = null;
  let answer: StatusDateView | null = null;
  let seq = 0;
  return {
    load(relPath: string): void {
      if (page !== relPath) answer = null;
      page = relPath;
      const url = claimCheckUrl(io.wiki(), relPath);
      if (!url) return;
      const mine = ++seq;
      (io.fetch ?? fetch)(url)
        .then((r) => (r.ok ? (r.json() as Promise<StatusDateView>) : null))
        .catch(() => null)
        .then((v) => {
          if (mine !== seq || page !== relPath) return;
          answer = v;
          io.onAnswer();
        });
    },
    /** The answer for `relPath`: null for another page, and until it arrives. */
    answerFor: (relPath: string | null): StatusDateView | null => (relPath !== null && relPath === page ? answer : null),
  };
}
