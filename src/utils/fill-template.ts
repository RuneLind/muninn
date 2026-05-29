/**
 * Substitute `{TOKEN}` slots in a prompt template with literal values.
 *
 * Uses function replacers so `$`-patterns in the substituted values
 * (`$&`, `$1`, `$\``, `$$`, …) are inserted verbatim instead of being
 * interpreted as `String.prototype.replace` replacement specials. A plain
 * `template.replace("{X}", userText)` would mangle any user/model text that
 * happened to contain those sequences.
 *
 * Only the first occurrence of each `{TOKEN}` is replaced (matching plain
 * string-replace semantics); each slot is expected to appear once.
 */
export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.replace(`{${key}}`, () => value);
  }
  return out;
}
