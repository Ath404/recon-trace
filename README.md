# recon-trace

Reconcile a bank statement against a Tally ledger and answer one question: **did this week's money in match the books, and if not, exactly which entry and by how much?**

```
$ npm run demo

HDFC RERA Escrow A/c: inflows · 43 bank rows (4 non-transaction rows skipped), 42 ledger lines from 42 vouchers

41 of 42 bank entries matched (₹1,87,35,250 of ₹1,89,27,000)
  by reference: 30   by amount + date: 11

HELD FOR REVIEW (1)
  amount differs by ₹12,500 (bank higher)
    bank    2026-10-15       ₹1,91,750  hdfc-escrow.csv:37  HDFCR50002026105847528
    ledger  2026-10-15       ₹1,79,250  tally-daybook.xml · Receipt 131  Buyer 017 - Tower A-1402

CHECKS
  ok    every bank entry accounted for exactly once
  ok    every ledger entry accounted for exactly once
  ok    bank buckets sum to the statement total
  ok    matched amounts equal on both sides
  ok    bank − ledger difference fully explained by held, ambiguous and unmatched items
```

Every line points at the row or voucher it came from, so a reviewer can open the file and check it.

## How it decides

Matching is deterministic and **order-independent**: a pair is accepted only when each side has exactly one candidate at that stage. Shuffling either file cannot change the answer (there is a test for that).

1. **Reference.** A UTR, cheque or instrument number on one side appears on the other: in the bank's ref column or narration, or in Tally's `BANKALLOCATIONS` instrument number. Equal amounts match. Unequal amounts are **held for review** with the signed difference. Someone has to decide which side is wrong.
2. **Amount + date.** Equal signed amount, tried at a 0-day gap first, then 1, up to `--window` (default 3). Same-day pairs settle before looser ones compete for them.
3. Whatever could still pair more than one way is reported as **ambiguous, not guessed**. Everything else is unmatched, on whichever side it sits.

Then the result is **tied out against the inputs** independently. Every entry lands in exactly one bucket, the buckets sum to the statement total, and the bank − ledger difference is fully explained. The CLI exits 1 if any check fails, so a pipeline can't publish a number that doesn't add up.

Money is integer paise and dates are whole days throughout: no floating point near a total.

## Inputs

- **Bank statement CSV.** `--bank-format hdfc` (default) uses HDFC's net-banking columns. Preamble, `****` separators and summary footers are skipped and counted. Any other bank: `--bank-map "date=Txn Date,amount=Amount,ref=UTR,narration=Description"` (or `debit=` + `credit=` instead of `amount=`). Dates are read as dd/mm, never mm/dd. Amounts in Indian grouping (`1,23,456.78`), `Dr`/`Cr` suffixes and `(brackets)` are handled.
- **Tally XML export** (Day Book / vouchers). `--ledger` names the bank ledger. Only that ledger's lines are used, from `ALLLEDGERENTRIES.LIST` or `LEDGERENTRIES.LIST`. Tally writes debits as negative amounts, and money into a bank is a debit to its ledger, so the sign is flipped by default.

```bash
npm install
npx tsx src/cli.ts --bank statement.csv --tally daybook.xml --ledger "HDFC Current A/c" --direction in
npx tsx src/cli.ts ... --json     # same result, machine-readable, every entry with its source
```

Also usable as a library: `parseBankCsv`, `parseTallyXml`, `reconcile`, `renderText`, `toJson`.

## The example

`examples/` holds one synthetic week of homebuyer receipts into a RERA escrow account. `scripts/make-example.ts` generates it deterministically with a known answer:

- 42 receipts. 30 carry a UTR that Tally also recorded; 11 don't.
- One was booked ₹12,500 short.
- One NEFT charge has no voucher. It shows up as "in bank, not in books" without `--direction in`.

`npm test` runs 37 tests. They cover the parsers, each matching rule, ambiguity, the shuffle invariance and the bundled example. They also regenerate the example and check that it comes out byte-for-byte the same.

## Honest limits

- **Formats are from published layouts, not real exports.** The HDFC column names and the Tally XML structure follow their documented formats. Neither has been run against a real customer file.
- **One-to-one only.** No splits: one receipt against two vouchers, or a bulk deposit against many. That is the next thing it needs.
- **The candidate search is O(n²) per stage.** Fine for a week or a month of one account. A year of a busy account would need bucketing by amount first.
- **Ledger names are compared case-insensitively but otherwise exactly.**

MIT licensed.
