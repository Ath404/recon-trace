import type { Day, Paise } from "./money.js";

/** Where a row came from, precise enough for a reviewer to open the file and find it. */
export interface SourceRef {
  file: string;
  /** 1-based line for CSV rows. */
  line?: number;
  /** Voucher type + number for Tally entries. */
  voucher?: string;
}

/**
 * One movement on the bank account, from either side. `amount` is signed from
 * the account's point of view: money in is positive, money out is negative.
 */
export interface Entry {
  id: string;
  side: "bank" | "ledger";
  day: Day;
  amount: Paise;
  /** Reference-like strings (UTR, cheque/instrument no.) used for strong matches. */
  refs: string[];
  /** Free text searched for the other side's references. */
  text: string;
  party?: string;
  source: SourceRef;
}
