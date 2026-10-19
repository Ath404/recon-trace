/**
 * Writes examples/hdfc-escrow.csv and examples/tally-daybook.xml: one week of
 * homebuyer receipts into a RERA escrow account, all synthetic.
 *
 * Built so the answer is known in advance:
 *   42 receipts on the statement
 *   30 carry a UTR that Tally also recorded            -> match by reference
 *   11 have no reference in Tally                      -> match by amount + date
 *    1 was booked in Tally ₹12,500 short of the receipt -> held for review
 * plus one bank charge with no voucher (only visible with --direction all).
 *
 * Deterministic: same seed, same files.
 */
import { writeFileSync } from "node:fs";

let seed = 20261012;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

const START = Date.UTC(2026, 9, 12);
const DAY = 86_400_000;
const dd = (t: number) => {
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCFullYear()).slice(2)}`;
};
const tallyDate = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
const indian = (rupees: number) => new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2 }).format(rupees);

interface Receipt {
  n: number;
  buyer: string;
  unit: string;
  amount: number;
  booked: number;
  bankDay: number;
  ledgerDay: number;
  utr: string;
  utrInTally: boolean;
}

const MILESTONES = [185000, 240000, 312500, 450000, 500000, 625000, 760000, 98000];
const used = new Set<string>();
const receipts: Receipt[] = [];
for (let i = 1; i <= 42; i++) {
  // Unique per receipt so the amount-only matches have exactly one answer.
  let amount: number;
  do amount = pick(MILESTONES) + Math.floor(rand() * 40) * 250;
  while (used.has(String(amount)));
  used.add(String(amount));
  const ledgerOffset = Math.floor(rand() * 6);
  const ledgerDay = START + ledgerOffset * DAY;
  const bankDay = ledgerDay + (rand() < 0.3 ? DAY : 0);
  receipts.push({
    n: i,
    buyer: `Buyer ${String(i).padStart(3, "0")}`,
    unit: `Tower ${pick(["A", "B", "C"])}-${pick([3, 7, 9, 12, 14])}${String(Math.floor(rand() * 4) + 1).padStart(2, "0")}`,
    amount,
    booked: amount,
    bankDay,
    ledgerDay,
    utr: `HDFCR5${String(2026101200000 + Math.floor(rand() * 9_999_999)).padStart(16, "0")}`,
    utrInTally: i <= 31,
  });
}
// Receipt 17: the accountant keyed the allotment-letter figure, not the amount that arrived.
receipts[16]!.booked = receipts[16]!.amount - 12500;

// ---- Bank statement, HDFC layout with its usual preamble and separator rows.
const csv: string[] = [
  "HDFC BANK Ltd.,,,,,,",
  "Account No :,50200012345678,,,,,",
  "Account Name :,SAMPLE REALTY LLP RERA ESCROW A/C,,,,,",
  `Statement From :,${dd(START)},To :,${dd(START + 6 * DAY)},,,`,
  ",,,,,,",
  "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  "********,********,********,********,********,********,********",
];
let balance = 18_450_000;
const bankRows = [
  ...receipts.map((r) => ({ t: r.bankDay, narration: `NEFT CR-HDFC0001234-${r.buyer.toUpperCase()} ${r.unit}-${r.utr}`, ref: r.utr, debit: 0, credit: r.amount })),
  { t: START + 5 * DAY, narration: "CHRG: NEFT/RTGS CHARGES INCL GST", ref: "000000000000000", debit: 590, credit: 0 },
].sort((a, b) => a.t - b.t || a.ref.localeCompare(b.ref));
for (const row of bankRows) {
  balance += row.credit - row.debit;
  csv.push(
    [dd(row.t), `"${row.narration}"`, row.ref, dd(row.t), row.debit ? `"${indian(row.debit)}"` : "", row.credit ? `"${indian(row.credit)}"` : "", `"${indian(balance)}"`].join(","),
  );
}
csv.push("********,********,********,********,********,********,********", "STATEMENT SUMMARY :-,,,,,,", `Closing Balance,"${indian(balance)}",,,,,`);
writeFileSync("examples/hdfc-escrow.csv", csv.join("\r\n") + "\r\n");

// ---- Tally Day Book export: Receipt vouchers, party credited, escrow ledger debited.
const BANK_LEDGER = "HDFC RERA Escrow A/c";
const vouchers = [...receipts]
  .sort((a, b) => a.ledgerDay - b.ledgerDay || a.n - b.n)
  .map((r, i) => {
    const party = `${r.buyer} - ${r.unit}`;
    const alloc = r.utrInTally
      ? `
       <BANKALLOCATIONS.LIST>
        <DATE>${tallyDate(r.ledgerDay)}</DATE>
        <INSTRUMENTDATE>${tallyDate(r.ledgerDay)}</INSTRUMENTDATE>
        <TRANSACTIONTYPE>e-Fund Transfer</TRANSACTIONTYPE>
        <INSTRUMENTNUMBER>${r.utr}</INSTRUMENTNUMBER>
        <AMOUNT>-${r.booked.toFixed(2)}</AMOUNT>
       </BANKALLOCATIONS.LIST>`
      : "";
    return `   <TALLYMESSAGE xmlns:UDF="TallyUDF">
    <VOUCHER VCHTYPE="Receipt" ACTION="Create">
     <DATE>${tallyDate(r.ledgerDay)}</DATE>
     <NARRATION>Instalment received, ${r.unit}</NARRATION>
     <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
     <VOUCHERNUMBER>${101 + i}</VOUCHERNUMBER>
     <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${party}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>${r.booked.toFixed(2)}</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${BANK_LEDGER}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${r.booked.toFixed(2)}</AMOUNT>${alloc}
     </ALLLEDGERENTRIES.LIST>
    </VOUCHER>
   </TALLYMESSAGE>`;
  });
const xml = `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES><SVCURRENTCOMPANY>Sample Realty LLP</SVCURRENTCOMPANY></STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
${vouchers.join("\n")}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
writeFileSync("examples/tally-daybook.xml", xml);
console.log(`wrote ${receipts.length} receipts; held receipt is ${receipts[16]!.buyer} (${receipts[16]!.utr})`);
