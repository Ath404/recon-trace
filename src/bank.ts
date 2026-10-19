import { parseDay, parsePaise } from "./money.js";
import type { Entry } from "./types.js";

/** Which header holds which field. Headers are compared after normalising case and punctuation. */
export interface ColumnMap {
  date: string;
  narration?: string;
  ref?: string;
  /** Either a single signed amount column... */
  amount?: string;
  /** ...or separate withdrawal/deposit columns. */
  debit?: string;
  credit?: string;
}

/**
 * HDFC net-banking statement layout, from HDFC's published column names.
 * Not yet checked against a real export; pass your own ColumnMap if headers differ.
 */
export const HDFC: ColumnMap = {
  date: "Date",
  narration: "Narration",
  ref: "Chq./Ref.No.",
  debit: "Withdrawal Amt.",
  credit: "Deposit Amt.",
};

export const PRESETS: Record<string, ColumnMap> = { hdfc: HDFC };

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. Returns rows with their 1-based line numbers. */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === "\n") line++;
        cell += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      rows.push({ line: rowLine, cells });
      cells = [];
      cell = "";
      line++;
      rowLine = line;
    } else cell += c;
  }
  if (cell || cells.length) {
    cells.push(cell);
    rows.push({ line: rowLine, cells });
  }
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Bank exports often start with account details and end with summaries. The
 * header is the first row containing every mapped column; rows after it whose
 * date does not parse (separators, footers) are skipped and counted.
 */
export function parseBankCsv(text: string, file: string, map: ColumnMap): { entries: Entry[]; skipped: number[] } {
  const rows = parseCsv(text);
  const wanted = Object.values(map).filter((v): v is string => Boolean(v));
  const headerIdx = rows.findIndex((r) => {
    const have = new Set(r.cells.map(norm));
    return wanted.every((w) => have.has(norm(w)));
  });
  if (headerIdx < 0) throw new Error(`${file}: no header row with columns ${wanted.join(", ")}`);
  const header = rows[headerIdx]!.cells.map(norm);
  const col = (name?: string) => (name ? header.indexOf(norm(name)) : -1);
  const c = { date: col(map.date), narration: col(map.narration), ref: col(map.ref), amount: col(map.amount), debit: col(map.debit), credit: col(map.credit) };
  if (c.amount < 0 && (c.debit < 0 || c.credit < 0)) throw new Error(`${file}: map needs either amount, or both debit and credit`);

  const entries: Entry[] = [];
  const skipped: number[] = [];
  for (const { line, cells } of rows.slice(headerIdx + 1)) {
    if (cells.every((x) => !x.trim())) continue;
    const day = parseDay(cells[c.date]);
    if (day === null) {
      skipped.push(line);
      continue;
    }
    let amount: number;
    if (c.amount >= 0) amount = parsePaise(cells[c.amount]) ?? 0;
    else amount = (parsePaise(cells[c.credit]) ?? 0) - (parsePaise(cells[c.debit]) ?? 0);
    if (amount === 0) {
      skipped.push(line);
      continue;
    }
    const narration = c.narration >= 0 ? (cells[c.narration] ?? "").trim() : "";
    const ref = c.ref >= 0 ? (cells[c.ref] ?? "").trim() : "";
    entries.push({
      id: `bank:${line}`,
      side: "bank",
      day,
      amount,
      refs: ref && !/^0+$/.test(ref) ? [ref] : [],
      text: narration,
      source: { file, line },
    });
  }
  return { entries, skipped };
}
