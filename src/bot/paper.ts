/**
 * Suivi papier en continu : enregistre le journal et fait tourner toutes les
 * stratégies en direct, sans jamais passer d'ordre ni lire de clé. Fait pour
 * tourner 24 h/24 sur le VPS, à côté du bot réel.
 *   npm run paper
 */
import { renameSync, writeFileSync } from "node:fs";
import { loadJournal, type Journal } from "./journal-data.ts";
import { startJournal } from "./journal.ts";
import { groupWindows, strategies, summarize, verdictOf, type WindowRows } from "./strategies.ts";

const DIR = process.env.JOURNAL_DIR ?? "data/journal";
const SCORE_FILE = `${DIR}/papier.json`;
const LIVE_FILE = `${DIR}/papier-live.json`;
const MIN_TRADES = 100;
const since = Math.floor(Date.now() / 1000);
const printed = new Map<string, number>();
let lastResolved = -1;

const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} $`;
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString("fr-FR");

/** Ordres papier de la fenêtre en cours, affichés dès qu'ils apparaissent. */
function live(journal: Journal) {
  const current = journal.pending.at(-1)?.window;
  if (current == null) return;
  const upOf = new Map(groupWindows(journal.rows).map((w) => [w.window, w.up]));
  const win: WindowRows = {
    window: current,
    rows: journal.pending.filter((r) => r.window === current),
    up: 0,
    previousUp: upOf.get(current - 300) ?? null,
  };
  const orders: { cle: string; nom: string; ordres: string[] }[] = [];
  for (const s of strategies()) {
    const trace = s.run(win, "instant")?.trace ?? [];
    const key = `${s.key}:${current}`;
    const done = printed.get(key) ?? 0;
    for (const line of trace.slice(done)) console.log(`papier · fenêtre ${clock(current)} · ${s.label} · ${line}`);
    printed.set(key, trace.length);
    orders.push({ cle: s.key, nom: s.label, ordres: trace });
  }
  // Pour la page web : les ordres papier de la fenêtre en cours.
  writeFileSync(`${LIVE_FILE}.tmp`, JSON.stringify({ majA: new Date().toISOString(), fenetre: current, strategies: orders }));
  renameSync(`${LIVE_FILE}.tmp`, LIVE_FILE);
  for (const key of printed.keys()) {
    if (Number(key.split(":")[1]) < current - 3600) printed.delete(key);
  }
}

/** Tableau des scores, à chaque nouvelle fenêtre réglée. */
function scoreboard(journal: Journal) {
  if (journal.resolved === lastResolved) return;
  lastResolved = journal.resolved;
  const all = groupWindows(journal.rows);
  const forward = all.filter((w) => w.window >= since);
  const rows = strategies().map((s) => {
    const full = summarize(all, s, "instant");
    const fwd = summarize(forward, s, "instant");
    return { key: s.key, label: s.label, depuisLancement: fwd, journal: { ...full, verdict: verdictOf(full, MIN_TRADES) } };
  });
  writeFileSync(
    SCORE_FILE,
    JSON.stringify({ majA: new Date().toISOString(), lancement: new Date(since * 1000).toISOString(), strategies: rows }, null, 2),
  );
  console.log(
    `\n=== Papier · ${forward.length} fenêtres depuis le lancement · ${all.length} dans tout le journal · mise de départ 5 $`,
  );
  console.log(`   ${"Stratégie".padEnd(46)} ${"depuis le lancement".padStart(22)}   ${"tout le journal".padStart(20)}   verdict`);
  for (const r of rows) {
    const f = r.depuisLancement;
    const j = r.journal;
    console.log(
      `   ${r.label.padEnd(46)} ${`${f.trades} trades ${signed(f.total)}`.padStart(22)}   ${`${j.trades} trades ${signed(j.total)}`.padStart(20)}   ${j.verdict}`,
    );
  }
  console.log(`Détail dans ${SCORE_FILE}.\n`);
}

function tick() {
  let journal: Journal;
  try {
    journal = loadJournal(DIR, { pending: true });
  } catch {
    return; // pas encore de fenêtre réglée
  }
  live(journal);
  scoreboard(journal);
}

console.log("Suivi papier · aucune clé, aucun ordre réel · toutes les stratégies du backtest, en direct.");
void startJournal();
setInterval(tick, 15_000);
setTimeout(tick, 5_000);
