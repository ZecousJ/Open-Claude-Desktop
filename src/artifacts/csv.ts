/** RFC 4180 rows: quoted fields may hold separators, quotes ("") and newlines. */
export function parseDelimited(
  text: string,
  separator = text.split("\n", 1)[0].includes("\t") ? "\t" : ",",
  maxRows = 1000,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === separator) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length > maxRows) break;
    } else field += c;
  }
  if (field !== "" || row.length) endRow();
  return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
}
