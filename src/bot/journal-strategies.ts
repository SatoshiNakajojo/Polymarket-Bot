/**
 * Backtest des stratégies sur le journal : un achat de 5 $ au départ, frais
 * preneur compris, deux vitesses d'exécution.
 *   npm run journal:strategies
 */
import { writeFileSync } from "node:fs";
import { loadJournal, type Journal } from "./journal-data.ts";
import { groupWindows, strategies, summarize, verdictOf, type Summary } from "./strategies.ts";

const DIR = process.env.JOURNAL_DIR ?? "data/journal";
const MIN_TRADES = 100;

const signed = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const pad = (s: string | number, n: number) => String(s).padStart(n);

function main() {
  let journal: Journal;
  try {
    journal = loadJournal(DIR);
  } catch (error) {
    console.log(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }
  const windows = groupWindows(journal.rows);
  console.log(`Backtest · ${windows.length} fenêtres réglées · mise de départ 5 $ · frais preneur compris`);
  console.log("« instant » = au prix du relevé où la décision est prise ; « lent » = au relevé suivant, 15 s plus tard.\n");
  const out: (Summary & { verdict: string })[] = [];
  for (const exec of ["instant", "lent"] as const) {
    console.log(`=== Exécution ${exec}`);
    console.log(`   ${"Stratégie".padEnd(46)} trades  gagnés   P&L total   P&L / trade       pire   baisse max  volume`);
    for (const s of strategies()) {
      const m = summarize(windows, s, exec);
      const verdict = verdictOf(m, MIN_TRADES);
      out.push({ ...m, verdict });
      if (m.trades === 0) {
        console.log(`   ${s.label.padEnd(46)} aucun trade`);
        continue;
      }
      const band = Number.isFinite(m.se) ? `± ${(2 * m.se).toFixed(2)}` : "";
      console.log(
        `   ${s.label.padEnd(46)} ${pad(m.trades, 6)}  ${pad((m.winRate * 100).toFixed(0) + " %", 6)}  ${pad(signed(m.total) + " $", 11)}  ${pad(signed(m.mean) + " $", 8)} ${band.padEnd(7)} ${pad(signed(m.worst, 0) + " $", 7)}  ${pad("-" + m.drawdown.toFixed(0) + " $", 9)}  ${pad(m.volume.toFixed(0) + " $", 7)}  ${verdict}`,
      );
    }
    console.log("");
  }
  const file = `${DIR}/strategies.json`;
  writeFileSync(file, JSON.stringify({ windows: windows.length, results: out }, null, 2));
  console.log(`Résultats détaillés dans ${file}.`);
  console.log(
    `Lecture : « POSITIF » ou « perdant » seulement quand l'écart dépasse deux fois l'incertitude, sur au moins ${MIN_TRADES} trades.`,
  );
}

main();
