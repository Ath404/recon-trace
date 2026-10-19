import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HDFC, parseBankCsv } from "../src/bank.js";
import { reconcile } from "../src/reconcile.js";
import { parseTallyXml } from "../src/tally.js";
import type { Entry } from "../src/types.js";

const D = Date.UTC(2026, 9, 12) / 86_400_000;
let n = 0;
const bank = (day: number, amount: number, refs: string[] = [], text = ""): Entry => ({ id: `bank:${++n}`, side: "bank", day: D + day, amount, refs, text, source: { file: "b.csv", line: n } });
const ledger = (day: number, amount: number, refs: string[] = [], text = ""): Entry => ({ id: `ledger:${++n}`, side: "ledger", day: D + day, amount, refs, text, source: { file: "t.xml", voucher: `Receipt ${n}` } });

const allOk = (r: ReturnType<typeof reconcile>) => r.checks.every((c) => c.ok);

describe("reconcile", () => {
  it("matches by reference even when the narration is the only place the bank shows it", () => {
    const r = reconcile([bank(0, 500, [], "NEFT CR-ACME-UTR998877")], [ledger(1, 500, ["UTR998877"])]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]).toMatchObject({ rule: "reference", dayGap: 1 });
    expect(allOk(r)).toBe(true);
  });

  it("holds a reference match whose amounts differ, with the signed difference", () => {
    const r = reconcile([bank(0, 191750_00, ["UTR555555"])], [ledger(0, 179250_00, ["UTR555555"])]);
    expect(r.matched).toHaveLength(0);
    expect(r.held).toEqual([expect.objectContaining({ reason: "amount_mismatch", difference: 12500_00 })]);
    expect(allOk(r)).toBe(true);
  });

  it("ignores short references: voucher 12 is not evidence", () => {
    const r = reconcile([bank(0, 100, [], "CHQ 12")], [ledger(0, 999, ["12"])]);
    expect(r.held).toHaveLength(0);
    expect(r.unmatchedBank).toHaveLength(1);
  });

  it("does not guess between two identical candidates", () => {
    const r = reconcile([bank(0, 50000_00), bank(0, 50000_00)], [ledger(0, 50000_00), ledger(1, 50000_00)]);
    expect(r.matched).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0]!.bank).toHaveLength(2);
    expect(allOk(r)).toBe(true);
  });

  it("settles same-day pairs before looser ones compete", () => {
    // Same amount on day 0 and day 2; a flat 3-day window would make this ambiguous.
    const r = reconcile([bank(0, 1000), bank(2, 1000)], [ledger(0, 1000), ledger(2, 1000)]);
    expect(r.matched.map((m) => m.dayGap)).toEqual([0, 0]);
    expect(r.ambiguous).toHaveLength(0);
  });

  it("respects the window and never pairs money in with money out", () => {
    const r = reconcile([bank(0, 1000), bank(0, -2000)], [ledger(5, 1000), ledger(0, 2000)], { windowDays: 3 });
    expect(r.matched).toHaveLength(0);
    expect(r.unmatchedBank).toHaveLength(2);
    expect(r.unmatchedLedger).toHaveLength(2);
    expect(allOk(r)).toBe(true);
  });

  it("direction=in leaves outflows out of the totals and the checks", () => {
    const r = reconcile([bank(0, 1000), bank(0, -590)], [ledger(0, 1000)], { direction: "in" });
    expect(r.totals.bank).toBe(1000);
    expect(r.unmatchedBank).toHaveLength(0);
    expect(allOk(r)).toBe(true);
  });

  it("gives the same answer whatever order the rows arrive in", () => {
    const b = [bank(0, 100, ["UTR100001"]), bank(0, 200), bank(1, 200), bank(2, 300), bank(0, 400, ["UTR400004"]), bank(3, 999)];
    const l = [ledger(0, 100, ["UTR100001"]), ledger(0, 200), ledger(1, 200), ledger(3, 300), ledger(0, 350, ["UTR400004"]), ledger(9, 5)];
    const key = (r: ReturnType<typeof reconcile>) =>
      JSON.stringify({
        m: r.matched.map((x) => `${x.bank.id}=${x.ledger.id}`).sort(),
        h: r.held.map((x) => `${x.bank.id}=${x.ledger.id}`).sort(),
        a: r.ambiguous.map((x) => [...x.bank, ...x.ledger].map((e) => e.id).sort().join()).sort(),
        ub: r.unmatchedBank.map((e) => e.id).sort(),
        ul: r.unmatchedLedger.map((e) => e.id).sort(),
      });
    const expected = key(reconcile(b, l));
    let s = 7;
    const shuffle = <T>(xs: T[]) => [...xs].sort(() => ((s = (s * 16807) % 2147483647) % 3) - 1);
    for (let i = 0; i < 25; i++) expect(key(reconcile(shuffle(b), shuffle(l)))).toBe(expected);
  });
});

describe("bundled example", () => {
  const load = () => {
    const b = parseBankCsv(readFileSync("examples/hdfc-escrow.csv", "utf8"), "hdfc-escrow.csv", HDFC);
    const t = parseTallyXml(readFileSync("examples/tally-daybook.xml", "utf8"), "tally-daybook.xml", { bankLedger: "HDFC RERA Escrow A/c" });
    return { b: b.entries, t: t.entries };
  };

  it("inflows: 41 of 42 matched, one held for ₹12,500", () => {
    const { b, t } = load();
    const r = reconcile(b, t, { direction: "in" });
    expect(r.matched).toHaveLength(41);
    expect(r.matched.filter((m) => m.rule === "reference")).toHaveLength(30);
    expect(r.held).toHaveLength(1);
    expect(r.held[0]!.difference).toBe(12500_00);
    expect(r.held[0]!.bank.source).toEqual({ file: "hdfc-escrow.csv", line: 37 });
    expect(allOk(r)).toBe(true);
  });

  it("all directions: the NEFT charge shows up as in-bank-not-in-books", () => {
    const { b, t } = load();
    const r = reconcile(b, t);
    expect(r.unmatchedBank.map((e) => e.amount)).toEqual([-590_00]);
    expect(allOk(r)).toBe(true);
  });

  it("the example files are what scripts/make-example.ts generates", () => {
    const before = readFileSync("examples/tally-daybook.xml", "utf8") + readFileSync("examples/hdfc-escrow.csv", "utf8");
    execFileSync(process.execPath, ["--import", "tsx", "scripts/make-example.ts"]);
    const after = readFileSync("examples/tally-daybook.xml", "utf8") + readFileSync("examples/hdfc-escrow.csv", "utf8");
    expect(after).toBe(before);
  });
});
