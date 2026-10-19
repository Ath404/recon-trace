import { XMLParser } from "fast-xml-parser";
import { parseDay, parsePaise } from "./money.js";
import type { Entry } from "./types.js";

export interface TallyOptions {
  /** The bank ledger's name in Tally, e.g. "HDFC Escrow A/c". Compared case-insensitively. */
  bankLedger: string;
  /**
   * Tally's XML writes debits as negative AMOUNTs, and money into a bank
   * account is a debit to its ledger, so the default flips the sign. Set true
   * if your export already uses the bank's sign.
   */
  bankSign?: boolean;
}

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  // Keep "00123" and "20261012" as strings; amounts are parsed to paise ourselves.
  parseTagValue: false,
  isArray: (name) => name.endsWith(".LIST") || name === "TALLYMESSAGE" || name === "VOUCHER",
});

/** Find every VOUCHER node, wherever the export nests it (Day Book, Ledger Vouchers, import envelopes). */
function vouchers(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach((n) => vouchers(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Node)) {
      if (k === "VOUCHER") (v as Node[]).forEach((x) => out.push(x));
      else vouchers(v, out);
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const list = (v: unknown) => (Array.isArray(v) ? (v as Node[]) : []);

/**
 * Extract the bank ledger's side of every voucher from a Tally XML export.
 * A voucher can touch the bank ledger more than once (rare, but split
 * receipts exist); each line becomes its own entry.
 */
export function parseTallyXml(xml: string, file: string, opts: TallyOptions): { entries: Entry[]; vouchersRead: number } {
  const doc = parser.parse(xml);
  const all = vouchers(doc);
  const target = opts.bankLedger.trim().toLowerCase();
  const entries: Entry[] = [];

  for (const v of all) {
    const day = parseDay(str(v.DATE));
    if (day === null) continue;
    const type = str(v.VOUCHERTYPENAME) || str(v["@_VCHTYPE"]) || "Voucher";
    const number = str(v.VOUCHERNUMBER);
    const voucher = number ? `${type} ${number}` : type;
    const lines = [...list(v["ALLLEDGERENTRIES.LIST"]), ...list(v["LEDGERENTRIES.LIST"])];

    lines.forEach((l, i) => {
      if (str(l.LEDGERNAME).toLowerCase() !== target) return;
      const raw = parsePaise(str(l.AMOUNT));
      if (raw === null || raw === 0) return;
      const instruments = list(l["BANKALLOCATIONS.LIST"]).map((b) => str(b.INSTRUMENTNUMBER) || str(b.UNIQUEREFERENCEID)).filter(Boolean);
      entries.push({
        id: `ledger:${voucher}${lines.length > 1 ? `#${i + 1}` : ""}`,
        side: "ledger",
        day,
        amount: opts.bankSign ? raw : -raw,
        refs: [...instruments, number].filter((r) => r.length > 0),
        text: [str(v.NARRATION), str(v.PARTYLEDGERNAME)].filter(Boolean).join(" "),
        party: str(v.PARTYLEDGERNAME) || undefined,
        source: { file, voucher },
      });
    });
  }
  return { entries, vouchersRead: all.length };
}
