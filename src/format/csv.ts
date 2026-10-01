/**
 * RFC 4180 CSV parser: quoted fields, `""` escapes, commas and newlines inside
 * quotes, LF or CRLF row ends, a leading BOM stripped. Rows shorter than the
 * widest row are padded with empty cells, so every row has the same width; a
 * blank line is skipped.
 * Dependency-free: the wiki reader's `<Query>` card renders from it server-side.
 */
export interface Csv {
  header: string[];
  rows: string[][];
}

export function parseCsv(text: string): Csv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    records.push(row);
    row = [];
    field = "";
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
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && src[i + 1] === "\n") {
      endRow();
      i++;
    } else if (ch === "\n") endRow();
    else field += ch;
    i++;
  }
  // A final record with no line end; a file ending in a line end adds none.
  if (field !== "" || row.length > 0 || quoted) endRow();
  // A blank line is no record (a trailing one is common in exported files).
  const kept = records.filter((r) => !(r.length === 1 && r[0] === ""));
  const width = kept.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of kept) while (r.length < width) r.push("");
  return { header: kept[0] ?? [], rows: kept.slice(1) };
}
