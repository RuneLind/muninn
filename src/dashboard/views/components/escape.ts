export function escHtml(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function escAttr(s: string | null | undefined): string { return escHtml(s); }
