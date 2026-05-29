/**
 * Substitute `{TOKEN}` slots in a prompt template with literal values.
 *
 * Single pass over the template, so:
 *  - `$`-patterns in the substituted values (`$&`, `$1`, `$\``, `$$`, …) are
 *    inserted verbatim — the function replacer is never re-interpreted as a
 *    `String.prototype.replace` replacement special. A plain
 *    `template.replace("{X}", userText)` would mangle text containing those.
 *  - a value that happens to contain another slot's `{TOKEN}` can never be
 *    re-substituted by a later key (the chained `.replace`-per-key approach
 *    would corrupt the template when, e.g., the user message literally
 *    contains `{ASSISTANT_RESPONSE}`).
 *
 * Unknown `{TOKEN}`s (no matching key in `values`) are left untouched.
 */
export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : match,
  );
}
