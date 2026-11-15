// CSV export. Excel opens it correctly in Hebrew thanks to the BOM at the start.
// Several sections go into one file, separated by two empty lines, each with its own header row.

export function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * sections: array of arrays of row objects. columns: [{key, label}].
 * Returns the file text.
 */
export function buildCsv(sections, columns) {
  const lines = [];
  sections.forEach((rows, i) => {
    if (i > 0) lines.push("", "");
    lines.push(columns.map((c) => csvCell(c.label)).join(","));
    for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key])).join(","));
  });
  return "﻿" + lines.join("\r\n");
}
