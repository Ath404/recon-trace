/**
 * Money is integer paise and dates are whole UTC days. No floats anywhere a
 * total is computed, so 0.1 + 0.2 never becomes the reason two books disagree.
 */

export type Paise = number;
/** Days since 1970-01-01 (UTC). */
export type Day = number;

/**
 * Parse an Indian-format amount: "1,23,456.78", "₹ 500", "(500.00)", "500.00 Dr",
 * "1200 Cr", "-75". Returns null for blanks so empty debit/credit cells are
 * distinguishable from zero.
 */
export function parsePaise(raw: string | undefined | null): Paise | null {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s || s === "-") return null;

  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  const suffix = s.match(/\s*(Dr|Cr)\.?$/i);
  if (suffix) {
    if (suffix[1]!.toLowerCase() === "dr") sign *= -1;
    s = s.slice(0, suffix.index);
  }
  s = s.replace(/[₹,\s]|INR|Rs\.?/gi, "");
  if (s.startsWith("-")) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Unparseable amount: ${JSON.stringify(raw)}`);
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(paise)) throw new Error(`Amount out of range: ${JSON.stringify(raw)}`);
  return sign * paise;
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function formatINR(paise: Paise): string {
  return inr.format(paise / 100);
}

/**
 * Parse the date shapes Indian bank and Tally exports use:
 * "20261012" (Tally), "12/10/26" and "12/10/2026" (dd/mm, banks), "2026-10-12", "12-Oct-2026".
 */
export function parseDay(raw: string | undefined): Day | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let y: number, mo: number, d: number;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) [d, mo, y] = [+m[1]!, +m[2]!, +m[3]!];
  else if ((m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{2}|\d{4})$/))) {
    const idx = MONTHS.indexOf(m[2]!.toLowerCase());
    if (idx < 0) return null;
    [d, mo, y] = [+m[1]!, idx + 1, +m[3]!];
  } else return null;
  if (y < 100) y += 2000;
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  // Reject 31/02 and friends instead of letting Date roll them into March.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return Math.round(t / 86_400_000);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function formatDay(day: Day): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}
