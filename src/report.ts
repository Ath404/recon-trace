import { formatDay, formatINR } from "./money.js";
import type { Result } from "./reconcile.js";
import type { Entry, SourceRef } from "./types.js";

export const where = (s: SourceRef) => (s.line !== undefined ? `${s.file}:${s.line}` : `${s.file} · ${s.voucher}`);
const brief = (e: Entry) => `${formatDay(e.day)}  ${formatINR(e.amount).padStart(14)}  ${where(e.source)}`;

export function renderText(r: Result, title?: string): string {
  const out: string[] = [];
  const bankCount = r.matched.length + r.held.length + r.unmatchedBank.length + r.ambiguous.reduce((n, a) => n + a.bank.length, 0);
  if (title) out.push(title, "");
  out.push(`${r.matched.length} of ${bankCount} bank entries matched (${formatINR(r.totals.matched)} of ${formatINR(r.totals.bank)})`);
  const byRule = (rule: string) => r.matched.filter((m) => m.rule === rule).length;
  out.push(`  by reference: ${byRule("reference")}   by amount + date: ${byRule("amount+date")}`, "");

  if (r.held.length) {
    out.push(`HELD FOR REVIEW (${r.held.length})`);
    for (const h of r.held) {
      out.push(`  amount differs by ${formatINR(Math.abs(h.difference))} (bank ${h.difference > 0 ? "higher" : "lower"})`);
      out.push(`    bank    ${brief(h.bank)}  ${h.bank.refs.join(" ")}`);
      out.push(`    ledger  ${brief(h.ledger)}  ${h.ledger.party ?? ""}`);
    }
    out.push("");
  }
  if (r.ambiguous.length) {
    out.push(`AMBIGUOUS, NOT GUESSED (${r.ambiguous.length} group${r.ambiguous.length > 1 ? "s" : ""})`);
    for (const a of r.ambiguous) {
      for (const e of a.bank) out.push(`    bank    ${brief(e)}`);
      for (const e of a.ledger) out.push(`    ledger  ${brief(e)}`);
      out.push("");
    }
  }
  if (r.unmatchedBank.length) {
    out.push(`IN BANK, NOT IN BOOKS (${r.unmatchedBank.length})`);
    for (const e of r.unmatchedBank) out.push(`    ${brief(e)}  ${e.text.slice(0, 40)}`);
    out.push("");
  }
  if (r.unmatchedLedger.length) {
    out.push(`IN BOOKS, NOT IN BANK (${r.unmatchedLedger.length})`);
    for (const e of r.unmatchedLedger) out.push(`    ${brief(e)}  ${e.party ?? ""}`);
    out.push("");
  }
  out.push("CHECKS");
  for (const c of r.checks) out.push(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  return out.join("\n");
}

/** JSON with every entry reduced to what a reviewer needs to find it. */
export function toJson(r: Result) {
  const e = (x: Entry) => ({ id: x.id, date: formatDay(x.day), amount: x.amount / 100, refs: x.refs, source: where(x.source) });
  return {
    summary: { matched: r.matched.length, held: r.held.length, ambiguousGroups: r.ambiguous.length, unmatchedBank: r.unmatchedBank.length, unmatchedLedger: r.unmatchedLedger.length },
    totals: { bank: r.totals.bank / 100, ledger: r.totals.ledger / 100, matched: r.totals.matched / 100 },
    matched: r.matched.map((m) => ({ rule: m.rule, dayGap: m.dayGap, bank: e(m.bank), ledger: e(m.ledger) })),
    held: r.held.map((h) => ({ reason: h.reason, difference: h.difference / 100, bank: e(h.bank), ledger: e(h.ledger) })),
    ambiguous: r.ambiguous.map((a) => ({ bank: a.bank.map(e), ledger: a.ledger.map(e) })),
    unmatchedBank: r.unmatchedBank.map(e),
    unmatchedLedger: r.unmatchedLedger.map(e),
    checks: r.checks,
  };
}
