#!/usr/bin/env bun
/**
 * Dry run of the decision chain and PR strip parsers over the `plans/` pages
 * of the wikis given, read-only:
 *
 *   bun --no-env-file scripts/decision-chain-dry-run.ts <wiki root> [<wiki root> …]
 *
 * Per page (`.md` and `.mdx` under `plans/`): chain count, orphan questions,
 * close conflicts, unknown PR states, edges from prose, and per ledger its
 * source, rows, share parsed to a known state and whether it draws. Then the
 * aggregates per wiki. Prints to stdout; writes nothing.
 */

import path from "node:path";
import { Glob } from "bun";
import { CHAIN_VIEW_MIN, STRIP_VIEW_MIN } from "../src/format/decision-views.ts";
import { lineageLine } from "../src/format/decision-chain.ts";
import { parseFrontmatter, readPlanStatus } from "../src/wiki/store.ts";
import { pageDecisionDataOf } from "../src/wiki/decision-text.ts";

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (x: number): string => (Number.isNaN(x) ? "-" : `${Math.round(x * 100)}%`);

async function dryRun(root: string): Promise<string[]> {
  const out: string[] = [`=== ${root}`];
  const files: string[] = [];
  for await (const rel of new Glob("plans/**/*.{md,mdx}").scan({ cwd: root, dot: false })) files.push(rel);
  files.sort();
  const shares: number[] = [];
  const stateShares: number[] = [];
  const chainCounts: number[] = [];
  let ledgers = 0;
  let glances = 0;
  let draws = 0;
  let stripViews = 0;
  let chainViews = 0;
  let pagesWithLog = 0;
  let unknownRows = 0;
  let proseEdges = 0;
  let orphans = 0;
  let conflicts = 0;
  for (const rel of files) {
    const md = await Bun.file(path.join(root, rel)).text();
    const { ledgers: ls, analysis } = pageDecisionDataOf(md, readPlanStatus(parseFrontmatter(md)) === "proposed");
    const hasLog = md.includes("<DecisionLog");
    if (!hasLog && ls.length === 0) continue;
    if (hasLog) pagesWithLog++;
    chainCounts.push(analysis.chains.length);
    if (analysis.chains.length >= CHAIN_VIEW_MIN) chainViews++;
    proseEdges += analysis.proseEdges;
    orphans += analysis.orphans.length;
    conflicts += analysis.conflicts.length;
    const unknown = ls.flatMap((l) => l.rows.filter((r) => r.state === "unknown").map((r) => r.pr));
    unknownRows += ls.filter((l) => l.source === "ledger" && l.stateColumn >= 0).flatMap((l) => l.rows.filter((r) => r.state === "unknown")).length;
    const stripRows = ls.filter((l) => l.draws).reduce((n, l) => n + l.rows.length, 0);
    if (stripRows >= STRIP_VIEW_MIN) stripViews++;
    out.push(
      `${rel}: chains=${analysis.chains.length} orphans=${analysis.orphans.map((o) => `${o.question}->${o.decision}`).join(",") || "-"} ` +
        `conflicts=${analysis.conflicts.map((c) => `${c.claimant}>${c.question}(${c.closedBy})`).join(",") || "-"} ` +
        `unknownPRs=${unknown.join(",") || "-"} proseEdges=${analysis.proseEdges}`,
    );
    for (const l of ls) {
      if (l.source === "ledger") {
        ledgers++;
        shares.push(l.parsedShare);
        if (l.stateColumn >= 0) stateShares.push(l.parsedShare);
      } else glances++;
      if (l.draws) draws++;
      out.push(
        `  ledger[${l.source}] rows=${l.rows.length} stateCol=${l.stateColumn >= 0 ? l.headers[l.stateColumn]!.trim() : "none"} ` +
          `parsed=${pct(l.parsedShare)} draws=${l.draws} states=${l.rows.map((r) => `${r.pr}:${r.state}`).join(" ")}`,
      );
    }
    for (const c of analysis.chains) out.push(`  ${lineageLine(c)}`);
  }
  const dist = new Map<string, number>();
  for (const n of chainCounts) {
    const b = n === 0 ? "0" : n <= 2 ? "1-2" : n <= 5 ? "3-5" : n <= 10 ? "6-10" : "11+";
    dist.set(b, (dist.get(b) ?? 0) + 1);
  }
  out.push(
    `--- aggregate ${path.basename(root)}: plan pages=${files.length} with DecisionLog=${pagesWithLog} ` +
      `ledgers=${ledgers} glance tables=${glances} drawing=${draws} (strip view on ${stripViews} pages) ` +
      `parse share median=${pct(median(shares))} min=${pct(shares.length ? Math.min(...shares) : NaN)} ` +
      `(${stateShares.length} with a state column: median=${pct(median(stateShares))} min=${pct(stateShares.length ? Math.min(...stateShares) : NaN)}) ` +
      `chain view on ${chainViews} pages, chains per page {${["0", "1-2", "3-5", "6-10", "11+"].map((b) => `${b}: ${dist.get(b) ?? 0}`).join(", ")}} ` +
      `unknown ledger rows=${unknownRows} prose edges=${proseEdges} orphans=${orphans} conflicts=${conflicts}`,
  );
  return out;
}

const roots = process.argv.slice(2);
if (!roots.length) {
  process.stderr.write("usage: bun --no-env-file scripts/decision-chain-dry-run.ts <wiki root> [...]\n");
  process.exit(2);
}
for (const root of roots) process.stdout.write((await dryRun(path.resolve(root))).join("\n") + "\n");
