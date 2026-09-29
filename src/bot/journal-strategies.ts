/**
 * Backtest des stratégies sur le journal : un achat de 5 $ au départ, frais
 * preneur compris, deux vitesses d'exécution.
 *   npm run journal:strategies
 */
import { writeFileSync } from "node:fs";
import { loadJournal, type Journal } from "./journal-data.ts";
import { meanSe } from "./journal-model.ts";
import { groupWindows, strategies, type Exec } from "./strategies.ts";

const DIR = process.env.JOURNAL_DIR ?? "data/journal";
const MIN_TRADES = 100;

export type Summary = {
  key: string;
  label: string;
  exec: Exec;
  trades: number;
  winRate: number;
  total: number;
  mean: number;
  se: number;
  worst: number;
  drawdown: number;
  volume: number;
  verdict: string;
};

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
  const out: Summary[] = [];
  for (const exec of ["instant", "lent"] as const) {
    console.log(`=== Exécution ${exec}`);
    console.log(`   ${"Stratégie".padEnd(46)} trades  gagnés   P&L total   P&L / trade       pire   baisse max  volume`);
    for (const s of strategies()) {
      const pnls: number[] = [];
      let volume = 0;
      let equity = 0;
      let peak = 0;
      let drawdown = 0;
      for (const w of windows) {
        const r = s.run(w, exec);
        if (!r) continue;
        pnls.push(r.pnl);
        volume += r.volume;
        equity += r.pnl;
        peak = Math.max(peak, equity);
        drawdown = Math.max(drawdown, peak - equity);
      }
      const m = meanSe(pnls);
      const total = pnls.reduce((a, b) => a + b, 0);
      const wins = pnls.filter((p) => p > 0).length;
      const verdict =
        m.n === 0
          ? "aucun trade"
          : m.n < MIN_TRADES
            ? "trop peu de trades"
            : m.mean - 2 * m.se > 0
              ? "POSITIF"
              : m.mean + 2 * m.se < 0
                ? "perdant"
                : "indistinct du hasard";
      const worst = pnls.length ? Math.min(...pnls) : 0;
      out.push({
        key: s.key,
        label: s.label,
        exec,
        trades: m.n,
        winRate: m.n ? wins / m.n : 0,
        total,
        mean: m.mean,
        se: m.se,
        worst,
        drawdown,
        volume,
        verdict,
      });
      if (m.n === 0) {
        console.log(`   ${s.label.padEnd(46)} aucun trade`);
        continue;
      }
      const band = Number.isFinite(m.se) ? `± ${(2 * m.se).toFixed(2)}` : "";
      console.log(
        `   ${s.label.padEnd(46)} ${pad(m.n, 6)}  ${pad(((wins / m.n) * 100).toFixed(0) + " %", 6)}  ${pad(signed(total) + " $", 11)}  ${pad(signed(m.mean) + " $", 8)} ${band.padEnd(7)} ${pad(signed(worst, 0) + " $", 7)}  ${pad("-" + drawdown.toFixed(0) + " $", 9)}  ${pad(volume.toFixed(0) + " $", 7)}  ${verdict}`,
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
