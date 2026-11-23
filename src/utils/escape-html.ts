export function escHtml(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function escAttr(s: string | null | undefined): string { return escHtml(s); }

/** JSON.stringify safe to embed in an inline `<script>`: escapes `<` so a value
 *  containing `</script>` (e.g. a reflected `?bot=` query) can't break out. */
export function escJsonScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}
