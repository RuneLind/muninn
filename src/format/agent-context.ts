/**
 * The fold titles that hold context for the next agent session rather than
 * for a reader (D22): the Overview lens hides a `<Fold>` whose title starts
 * with one of them. The list is pinned to `fixtures/reader-shared.json`, the
 * file plan-card keeps a copy of, by `agent-context.test.ts`.
 */

export const AGENT_CONTEXT_FOLD_NAMES: readonly string[] = [
  "Handoff",
  "Current state",
  "Nåværende tilstand",
  "Nåtilstand",
  "Overlevering",
  "Gjeldende status",
  "Status ved sesjonsslutt",
];

/** A title that starts with one of the names, any case, followed by the end
 *  or a character that is not a letter or digit (`Handoff — 08.10`, not
 *  `Handoffs`). */
export function isAgentContextTitle(title: string): boolean {
  const t = title.normalize("NFC").trim().toLocaleLowerCase("nb");
  return AGENT_CONTEXT_FOLD_NAMES.some((name) => {
    const n = name.normalize("NFC").toLocaleLowerCase("nb");
    return t.startsWith(n) && !/^[\p{L}\p{N}]/u.test(t.slice(n.length));
  });
}
