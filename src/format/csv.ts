/**
 * RFC 4180 CSV parser: quoted fields, `""` escapes, commas and newlines inside
 * quotes, LF, CRLF or a lone CR as row ends, a leading BOM stripped. Rows
 * shorter than the widest row are padded with empty cells, so every row has the
 * same width. The final line end makes no row.
 *
 * An empty unquoted line is skipped only when the header has two or more
 * columns: in a one-column file it is an empty value (psql writes NULL that
 * way). A record holding a quoted `""` is always kept.
 *
 * Dependency-free: the wiki reader's `<Query>` card renders from it server-side.
 */
export interface Csv {
  header: string[];
  rows: string[][];
  /** Set when a quote opened and never closed: the rest of the file is in one cell. */
  warning?: "unterminated-quote";
}

export function parseCsv(text: string): Csv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: { cells: string[]; quoted: boolean }[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let rowQuoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    records.push({ cells: row, quoted: rowQuoted });
    row = [];
    field = "";
    rowQuoted = false;
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      rowQuoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      endRow();
      if (src[i + 1] === "\n") i++;
    } else if (ch === "\n") endRow();
    else field += ch;
    i++;
  }
  const unterminated = quoted;
  // A final record with no line end; a file ending in a line end adds none.
  if (field !== "" || row.length > 0 || rowQuoted) endRow();
  const blank = (r: { cells: string[]; quoted: boolean }) => !r.quoted && r.cells.length === 1 && r.cells[0] === "";
  // Leading blank lines are never the header.
  const start = records.findIndex((r) => !blank(r));
  const body = start === -1 ? [] : records.slice(start);
  const multiColumn = (body[0]?.cells.length ?? 0) >= 2;
  const kept = body.filter((r, k) => k === 0 || !multiColumn || !blank(r)).map((r) => r.cells);
  const width = kept.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of kept) while (r.length < width) r.push("");
  return {
    header: kept[0] ?? [],
    rows: kept.slice(1),
    ...(unterminated ? { warning: "unterminated-quote" as const } : {}),
  };
}
