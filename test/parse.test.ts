import { describe, expect, it } from "vitest";
import { HDFC, parseBankCsv, parseCsv } from "../src/bank.js";
import { formatINR, parseDay, parsePaise } from "../src/money.js";
import { parseTallyXml } from "../src/tally.js";

describe("parsePaise", () => {
  it.each([
    ["1,23,456.78", 12345678],
    ["₹ 500", 50000],
    ["(500.00)", -50000],
    ["500.00 Dr", -50000],
    ["1200 Cr", 120000],
    ["-75.5", -7550],
    ["Rs. 1,000", 100000],
    ["0.1", 10],
  ])("%s -> %d paise", (raw, paise) => expect(parsePaise(raw)).toBe(paise));

  it("treats blank cells as null, not zero", () => {
    expect(parsePaise("")).toBeNull();
    expect(parsePaise("  ")).toBeNull();
  });

  it("refuses to guess at garbage or a third decimal", () => {
    expect(() => parsePaise("12.345")).toThrow();
    expect(() => parsePaise("abc")).toThrow();
  });

  it("formats with Indian grouping", () => expect(formatINR(1872525000)).toBe("₹1,87,25,250"));
});

describe("parseDay", () => {
  const oct12 = Date.UTC(2026, 9, 12) / 86_400_000;
  it.each(["20261012", "12/10/26", "12/10/2026", "2026-10-12", "12-Oct-2026", "12.10.2026"])("%s", (s) => expect(parseDay(s)).toBe(oct12));
  it("rejects impossible dates instead of rolling them over", () => expect(parseDay("31/02/26")).toBeNull());
  it("reads dd/mm, never mm/dd", () => expect(parseDay("01/02/26")).toBe(Date.UTC(2026, 1, 1) / 86_400_000));
});

describe("CSV", () => {
  it("handles quotes, doubled quotes, commas and newlines inside fields, and CRLF", () => {
    const rows = parseCsv('a,"b,c","say ""hi"""\r\n"multi\nline",x,y\r\n');
    expect(rows).toEqual([
      { line: 1, cells: ["a", "b,c", 'say "hi"'] },
      { line: 2, cells: ["multi\nline", "x", "y"] },
    ]);
  });

  it("finds the HDFC header below the preamble and skips separator and footer rows", () => {
    const csv = [
      "HDFC BANK Ltd.,,,,,,",
      "Account No :,123,,,,,",
      "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
      "********,********,********,********,********,********,********",
      '12/10/26,"NEFT CR-X-UTR123456",UTR123456,12/10/26,,"2,40,000.00","5,00,000.00"',
      '13/10/26,CHRG,000000000000,13/10/26,590.00,,"4,99,410.00"',
      "STATEMENT SUMMARY :-,,,,,,",
    ].join("\n");
    const { entries, skipped } = parseBankCsv(csv, "s.csv", HDFC);
    expect(entries.map((e) => [e.amount, e.refs, e.source.line])).toEqual([
      [24000000, ["UTR123456"], 5],
      [-59000, [], 6],
    ]);
    expect(skipped).toEqual([4, 7]);
  });

  it("supports a single signed amount column through a custom map", () => {
    const { entries } = parseBankCsv("Txn Date,Amount,Description\n2026-10-12,-1500,Rent\n", "x.csv", { date: "Txn Date", amount: "Amount", narration: "Description" });
    expect(entries[0]).toMatchObject({ amount: -150000, text: "Rent" });
  });

  it("names the missing columns when no header matches", () => {
    expect(() => parseBankCsv("a,b\n1,2\n", "x.csv", HDFC)).toThrow(/Withdrawal Amt/);
  });
});

describe("Tally XML", () => {
  const xml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
    <TALLYMESSAGE><VOUCHER VCHTYPE="Receipt">
      <DATE>20261012</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>00118</VOUCHERNUMBER>
      <PARTYLEDGERNAME>Buyer 001</PARTYLEDGERNAME><NARRATION>Instalment</NARRATION>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Buyer 001</LEDGERNAME><AMOUNT>240000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Escrow</LEDGERNAME><AMOUNT>-240000.00</AMOUNT>
        <BANKALLOCATIONS.LIST><INSTRUMENTNUMBER>UTR123456</INSTRUMENTNUMBER></BANKALLOCATIONS.LIST>
      </ALLLEDGERENTRIES.LIST>
    </VOUCHER></TALLYMESSAGE>
    <TALLYMESSAGE><VOUCHER VCHTYPE="Payment">
      <DATE>20261013</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>7</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank Charges</LEDGERNAME><AMOUNT>-590.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>hdfc escrow</LEDGERNAME><AMOUNT>590.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></TALLYMESSAGE>
  </REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  it("takes only the bank ledger's lines, flips Tally's debit sign, and keeps the instrument number", () => {
    const { entries, vouchersRead } = parseTallyXml(xml, "d.xml", { bankLedger: "HDFC Escrow" });
    expect(vouchersRead).toBe(2);
    expect(entries.map((e) => [e.amount, e.refs, e.source.voucher])).toEqual([
      [24000000, ["UTR123456", "00118"], "Receipt 00118"],
      [-59000, ["7"], "Payment 7"],
    ]);
  });

  it("keeps leading zeros and dates as text", () => {
    const { entries } = parseTallyXml(xml, "d.xml", { bankLedger: "HDFC Escrow" });
    expect(entries[0]!.refs).toContain("00118");
  });

  it("honours bankSign for exports already in the bank's sign", () => {
    const { entries } = parseTallyXml(xml, "d.xml", { bankLedger: "HDFC Escrow", bankSign: true });
    expect(entries[0]!.amount).toBe(-24000000);
  });
});
