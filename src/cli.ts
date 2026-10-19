#!/usr/bin/env node
/**
 *   recon-trace --bank statement.csv --tally daybook.xml --ledger "HDFC Escrow A/c" [--direction in] [--json]
 *
 * Bank columns: --bank-format hdfc (default), or --bank-map "date=Txn Date,amount=Amount,ref=UTR,narration=Description".
 * Exits 1 if any tie-out check fails, 2 on bad input.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { PRESETS, parseBankCsv, type ColumnMap } from "./bank.js";
import { reconcile } from "./reconcile.js";
import { renderText, toJson } from "./report.js";
import { parseTallyXml } from "./tally.js";

function parseMap(spec: string): ColumnMap {
  const map: Record<string, string> = {};
  for (const pair of spec.split(",")) {
    const [k, ...v] = pair.split("=");
    if (!k || !v.length) throw new Error(`Bad --bank-map entry: ${pair}`);
    map[k.trim()] = v.join("=").trim();
  }
  if (!map.date) throw new Error("--bank-map needs date=<header>");
  return map as unknown as ColumnMap;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      bank: { type: "string" },
      "bank-format": { type: "string", default: "hdfc" },
      "bank-map": { type: "string" },
      tally: { type: "string" },
      ledger: { type: "string" },
      window: { type: "string", default: "3" },
      direction: { type: "string", default: "all" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.bank || !values.tally || !values.ledger) {
    console.error('usage: recon-trace --bank <csv> --tally <xml> --ledger "<bank ledger name>" [--direction in|out|all] [--window 3] [--json]');
    return 2;
  }
  const map = values["bank-map"] ? parseMap(values["bank-map"]) : PRESETS[values["bank-format"]!];
  if (!map) throw new Error(`Unknown --bank-format ${values["bank-format"]}; known: ${Object.keys(PRESETS).join(", ")}`);
  const direction = values.direction as "in" | "out" | "all";
  if (!["in", "out", "all"].includes(direction)) throw new Error("--direction must be in, out or all");

  const bank = parseBankCsv(readFileSync(values.bank, "utf8"), basename(values.bank), map);
  const tally = parseTallyXml(readFileSync(values.tally, "utf8"), basename(values.tally), { bankLedger: values.ledger });
  if (!tally.entries.length) throw new Error(`No entries for ledger "${values.ledger}" in ${tally.vouchersRead} vouchers`);

  const result = reconcile(bank.entries, tally.entries, { windowDays: Number(values.window), direction });
  if (values.json) console.log(JSON.stringify(toJson(result), null, 2));
  else {
    const label = direction === "in" ? "inflows" : direction === "out" ? "outflows" : "entries";
    console.log(renderText(result, `${values.ledger}: ${label} · ${bank.entries.length} bank rows (${bank.skipped.length} non-transaction rows skipped), ${tally.entries.length} ledger lines from ${tally.vouchersRead} vouchers`));
  }
  return result.checks.every((c) => c.ok) ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 2;
}
