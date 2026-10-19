import type { Paise } from "./money.js";
import type { Entry } from "./types.js";

export interface ReconcileOptions {
  /** Max days between bank date and ledger date for an amount-only match. Default 3. */
  windowDays?: number;
  /** Max days for a reference match; cheques and RTGS returns can clear slowly. Default 7. */
  refWindowDays?: number;
  /** References shorter than this are ignored (voucher "12" is not evidence). Default 6. */
  minRefLength?: number;
  /** Only reconcile money in, money out, or both. Default "all". */
  direction?: "in" | "out" | "all";
}

export type Rule = "reference" | "amount+date";

export interface Match {
  rule: Rule;
  bank: Entry;
  ledger: Entry;
  dayGap: number;
}

/** Same transaction by reference, different amount: a person must decide which side is wrong. */
export interface Held {
  reason: "amount_mismatch";
  bank: Entry;
  ledger: Entry;
  /** bank − ledger */
  difference: Paise;
}

/** Entries that could pair more than one way. Guessing here is how books end up wrong, so they are listed, not matched. */
export interface Ambiguous {
  bank: Entry[];
  ledger: Entry[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface Result {
  matched: Match[];
  held: Held[];
  ambiguous: Ambiguous[];
  unmatchedBank: Entry[];
  unmatchedLedger: Entry[];
  totals: { bank: Paise; ledger: Paise; matched: Paise };
  checks: Check[];
}

const normRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Deterministic, order-independent matching. A pair is only accepted when each
 * side has exactly one candidate at that stage; anything else waits for a
 * later stage or ends up ambiguous. Shuffling either input cannot change the
 * result.
 *
 *   1. reference: a UTR / instrument number on one side appears on the other.
 *      Equal amounts match; unequal amounts are held for review.
 *   2. amount+date: equal signed amount, tried at a day gap of 0, then 1, ...
 *      up to windowDays, so same-day pairs settle before looser ones compete.
 */
export function reconcile(bankIn: Entry[], ledgerIn: Entry[], opts: ReconcileOptions = {}): Result {
  const windowDays = opts.windowDays ?? 3;
  const refWindowDays = opts.refWindowDays ?? 7;
  const minRef = opts.minRefLength ?? 6;
  const keep = (e: Entry) => opts.direction === "in" ? e.amount > 0 : opts.direction === "out" ? e.amount < 0 : true;
  const bank = bankIn.filter(keep);
  const ledger = ledgerIn.filter(keep);

  const used = new Set<string>();
  const matched: Match[] = [];
  const held: Held[] = [];
  const free = (xs: Entry[]) => xs.filter((x) => !used.has(x.id));

  const refKeys = (e: Entry) => e.refs.map(normRef).filter((r) => r.length >= minRef);
  const refLinked = (b: Entry, l: Entry) => {
    const bText = normRef(`${b.refs.join(" ")} ${b.text}`);
    const lText = normRef(`${l.refs.join(" ")} ${l.text}`);
    return refKeys(l).some((r) => bText.includes(r)) || refKeys(b).some((r) => lText.includes(r));
  };
  const gap = (b: Entry, l: Entry) => Math.abs(b.day - l.day);
  const sameSign = (b: Entry, l: Entry) => Math.sign(b.amount) === Math.sign(l.amount);

  // Stage 1: references.
  acceptUnique(free(bank), free(ledger), (b, l) => sameSign(b, l) && gap(b, l) <= refWindowDays && refLinked(b, l), (b, l) => {
    used.add(b.id).add(l.id);
    if (b.amount === l.amount) matched.push({ rule: "reference", bank: b, ledger: l, dayGap: gap(b, l) });
    else held.push({ reason: "amount_mismatch", bank: b, ledger: l, difference: b.amount - l.amount });
  });

  // Stage 2: amount + widening date window.
  for (let g = 0; g <= windowDays; g++) {
    acceptUnique(free(bank), free(ledger), (b, l) => b.amount === l.amount && gap(b, l) <= g, (b, l) => {
      used.add(b.id).add(l.id);
      matched.push({ rule: "amount+date", bank: b, ledger: l, dayGap: gap(b, l) });
    });
  }

  // Whatever still has a plausible partner is ambiguous; the rest is simply unmatched.
  const restB = free(bank);
  const restL = free(ledger);
  const plausible = (b: Entry, l: Entry) => (b.amount === l.amount && gap(b, l) <= windowDays) || (sameSign(b, l) && gap(b, l) <= refWindowDays && refLinked(b, l));
  const ambiguous = components(restB, restL, plausible);
  const inAmbiguous = new Set(ambiguous.flatMap((a) => [...a.bank, ...a.ledger]).map((e) => e.id));

  const order = (a: Entry, b: Entry) => a.day - b.day || a.id.localeCompare(b.id);
  matched.sort((x, y) => order(x.bank, y.bank));
  held.sort((x, y) => order(x.bank, y.bank));
  const result: Result = {
    matched,
    held,
    ambiguous,
    unmatchedBank: restB.filter((e) => !inAmbiguous.has(e.id)).sort(order),
    unmatchedLedger: restL.filter((e) => !inAmbiguous.has(e.id)).sort(order),
    totals: { bank: sum(bank), ledger: sum(ledger), matched: sum(matched.map((m) => m.bank)) },
    checks: [],
  };
  result.checks = verify(result, bank, ledger);
  return result;
}

/**
 * Accept every (b, l) edge where b has exactly one candidate and l has exactly
 * one candidate. Computed from the full candidate graph before accepting
 * anything, so input order cannot matter.
 */
function acceptUnique(bank: Entry[], ledger: Entry[], edge: (b: Entry, l: Entry) => boolean, accept: (b: Entry, l: Entry) => void) {
  const byBank = new Map<string, Entry[]>();
  const byLedger = new Map<string, number>();
  for (const b of bank) {
    const cands = ledger.filter((l) => edge(b, l));
    byBank.set(b.id, cands);
    for (const l of cands) byLedger.set(l.id, (byLedger.get(l.id) ?? 0) + 1);
  }
  for (const b of bank) {
    const cands = byBank.get(b.id)!;
    if (cands.length === 1 && byLedger.get(cands[0]!.id) === 1) accept(b, cands[0]!);
  }
}

function components(bank: Entry[], ledger: Entry[], edge: (b: Entry, l: Entry) => boolean): Ambiguous[] {
  const seen = new Set<string>();
  const out: Ambiguous[] = [];
  for (const start of bank) {
    if (seen.has(start.id) || !ledger.some((l) => edge(start, l))) continue;
    const group: Ambiguous = { bank: [], ledger: [] };
    const queue: Entry[] = [start];
    seen.add(start.id);
    while (queue.length) {
      const e = queue.shift()!;
      (e.side === "bank" ? group.bank : group.ledger).push(e);
      const next = e.side === "bank" ? ledger.filter((l) => edge(e, l)) : bank.filter((b) => edge(b, e));
      for (const n of next) if (!seen.has(n.id)) (seen.add(n.id), queue.push(n));
    }
    out.push(group);
  }
  return out;
}

const sum = (xs: Entry[]) => xs.reduce((s, e) => s + e.amount, 0);

/**
 * Independent tie-out of the result against the inputs. These cannot fail
 * unless the matcher has a bug, which is the point: the report says so
 * instead of silently publishing a number that doesn't add up.
 */
export function verify(r: Result, bank: Entry[], ledger: Entry[]): Check[] {
  const checks: Check[] = [];
  const once = (name: string, all: Entry[], buckets: Entry[][]) => {
    const ids = buckets.flat().map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    const missing = all.filter((e) => !ids.includes(e.id)).map((e) => e.id);
    checks.push({
      name,
      ok: dupes.length === 0 && missing.length === 0 && ids.length === all.length,
      detail: dupes.length || missing.length ? `duplicated: ${dupes.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}` : undefined,
    });
  };
  once("every bank entry accounted for exactly once", bank, [r.matched.map((m) => m.bank), r.held.map((h) => h.bank), r.ambiguous.flatMap((a) => a.bank), r.unmatchedBank]);
  once("every ledger entry accounted for exactly once", ledger, [r.matched.map((m) => m.ledger), r.held.map((h) => h.ledger), r.ambiguous.flatMap((a) => a.ledger), r.unmatchedLedger]);

  const bucketTotal = sum(r.matched.map((m) => m.bank)) + sum(r.held.map((h) => h.bank)) + sum(r.ambiguous.flatMap((a) => a.bank)) + sum(r.unmatchedBank);
  checks.push({ name: "bank buckets sum to the statement total", ok: bucketTotal === sum(bank) });
  checks.push({
    name: "matched amounts equal on both sides",
    ok: r.matched.every((m) => m.bank.amount === m.ledger.amount) && sum(r.matched.map((m) => m.bank)) === sum(r.matched.map((m) => m.ledger)),
  });
  const heldDiff = r.held.reduce((s, h) => s + h.difference, 0);
  const expected = sum(bank) - sum(ledger);
  const unexplained = expected - heldDiff - (sum(r.unmatchedBank) - sum(r.unmatchedLedger)) - (sum(r.ambiguous.flatMap((a) => a.bank)) - sum(r.ambiguous.flatMap((a) => a.ledger)));
  checks.push({ name: "bank − ledger difference fully explained by held, ambiguous and unmatched items", ok: unexplained === 0 });
  return checks;
}
