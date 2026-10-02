/**
 * Entraîne l'IA sur le journal et la juge sur des fenêtres jamais vues.
 *   npm run ia              une fois
 *   npm run ia -- --boucle  toutes les 6 h, pour tourner sur le VPS avec pm2
 * Écrit data/journal/ia.json (lu par la page) et ia-historique.jsonl.
 * Aucune clé, aucun ordre.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { loadJournal } from "./journal-data.ts";
import { evaluate, iaSamples, OBJECTIF, VERDICT_EDGE, verdictOf, type ModelReport } from "./ia.ts";

const DIR = process.env.JOURNAL_DIR ?? "data/journal";
const FILE = `${DIR}/ia.json`;
const HISTORY = `${DIR}/ia-historique.jsonl`;
const STAKE = Number(process.env.JOURNAL_STAKE ?? 5);
const HOURS = Number(process.env.IA_HEURES ?? 6);
const MIN_WINDOWS = Number(process.env.IA_MIN ?? 300);

const signed = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const pad = (s: string | number, n: number) => String(s).padStart(n);

function lastWindows(): number | null {
  try {
    return (JSON.parse(readFileSync(FILE, "utf8")) as { journal?: number }).journal ?? null;
  } catch {
    return null;
  }
}

function print(m: ModelReport) {
  console.log(`\n${m.nom}`);
  console.log(
    `   perte log ${m.perteModele.toFixed(4)} contre ${m.perteMarche.toFixed(4)} pour le marché · écart ${signed(m.ecart.mean, 4)} ± ${(2 * m.ecart.se).toFixed(4)} → ${m.ecart.verdict}`,
  );
  console.log(`   ${m.cle === "arbres" ? "arbres gardés" : "époques gardées"} par entraînement : ${m.etapes.join(", ")}`);
  if (m.importance) {
    const top = m.importance.filter((s) => s.part > 0.005).slice(0, 5);
    console.log(
      `   ce qu'elle regarde : ${top.length ? top.map((s) => `${s.signal} ${Math.round(s.part * 100)} %`).join(" · ") : "rien (elle reste sur le prix du marché)"}`,
    );
  }
  console.log("   Écart min.  exécution         trades   gagnés    P&L total    P&L / trade");
  for (const t of m.trading) {
    if (t.trades === 0) {
      console.log(`   ${pad(`${t.ecart * 100} c`, 6)}      ${t.execution.padEnd(15)}   aucun trade`);
      continue;
    }
    console.log(
      `   ${pad(`${t.ecart * 100} c`, 6)}      ${t.execution.padEnd(15)} ${pad(t.trades, 6)}   ${pad(`${((t.gagnes / t.trades) * 100).toFixed(1)} %`, 7)}   ${pad(`${signed(t.total)} $`, 11)}    ${signed(t.moyenne)} $${t.incertitude != null ? ` ± ${t.incertitude.toFixed(2)}` : ""}`,
    );
  }
}

function run(): boolean {
  let samples;
  let resolved: number;
  try {
    const journal = loadJournal(DIR);
    resolved = journal.resolved;
    samples = iaSamples(journal.rows);
  } catch (error) {
    console.log(error instanceof Error ? error.message : error);
    return false;
  }
  const windows = new Set(samples.map((s) => s.window)).size;
  const t0 = Date.now();
  console.log(`\n=== IA · ${new Date().toLocaleString("fr-FR")} · ${samples.length} relevés complets sur ${windows} fenêtres réglées`);
  if (windows < MIN_WINDOWS) {
    console.log(`Il faut au moins ${MIN_WINDOWS} fenêtres complètes. Laisse tourner fenetre-papier.`);
    return false;
  }
  const { fenetresTest, modeles } = evaluate(samples, { stake: STAKE });
  const { verdict, explication } = verdictOf(windows, modeles);
  console.log(`Jugée sur ${fenetresTest} fenêtres qu'elle n'avait jamais vues · mise ${STAKE} $, frais compris.`);
  for (const m of modeles) print(m);
  console.log(`\nVerdict (${windows}/${OBJECTIF} fenêtres) : ${verdict}. ${explication}`);
  console.log(`Calcul en ${Math.round((Date.now() - t0) / 1000)} s.`);
  const now = new Date().toISOString();
  writeFileSync(
    `${FILE}.tmp`,
    JSON.stringify(
      { majA: now, journal: resolved, fenetres: windows, releves: samples.length, objectif: OBJECTIF, ecartVerdict: VERDICT_EDGE, fenetresTest, verdict, explication, modeles },
      null,
      2,
    ),
  );
  renameSync(`${FILE}.tmp`, FILE);
  const at = (m: ModelReport) => m.trading.find((t) => t.ecart === VERDICT_EDGE && t.execution === "immédiate");
  appendFileSync(
    HISTORY,
    `${JSON.stringify({
      majA: now,
      fenetres: windows,
      verdict,
      modeles: modeles.map((m) => ({ cle: m.cle, ecart: m.ecart.mean, incertitude: 2 * m.ecart.se, trades: at(m)?.trades ?? 0, pnl: at(m)?.total ?? 0 })),
    })}\n`,
  );
  console.log(`Résultat dans ${FILE}.`);
  return true;
}

if (process.argv.includes("--boucle")) {
  console.log(`IA · aucune clé, aucun ordre · réentraînée toutes les ${HOURS} h sur le journal.`);
  const tick = () => {
    let windows: number | null = null;
    try {
      windows = loadJournal(DIR).resolved;
    } catch {
      /* journal pas encore prêt */
    }
    // Pas de nouvelles fenêtres depuis la dernière fois : inutile de recalculer.
    if (windows != null && windows === lastWindows()) return;
    run();
  };
  tick();
  setInterval(tick, HOURS * 3600 * 1000);
} else if (!run()) {
  process.exitCode = 1;
}
