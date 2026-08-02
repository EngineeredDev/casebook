/**
 * The characters a spreadsheet reads as "this cell is a formula" rather than as
 * text. OWASP's list, all six: the tab and the carriage return are on it
 * because Excel discards leading whitespace before it decides, so a cell that
 * begins with a tab and then an "=" is still a formula.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(v: string | number): string {
  /**
   * Strings only, and the type test is doing real work rather than pleasing the
   * compiler: every numeric column she exports — minutes, hours, group size —
   * arrives here as a number, and a negative one starts with "-". Prefixing
   * those would turn -45 minutes into the text '-45, so every total in the
   * report someone opens would come out wrong. That is a far likelier accident
   * than the one below, which needs her to have named a student "=SUM(A1:A9)".
   */
  const s = typeof v === "string" && FORMULA_LEAD.test(v) ? `'${v}` : String(v);
  // A leading apostrophe is the spreadsheet's own "treat this as text" marker:
  // it is not part of the value, does not print, and survives a round trip.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
