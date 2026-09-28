/**
 * Entraîne le modèle appris sur le journal et vérifie, sur des fenêtres qu'il
 * n'a jamais vues, s'il prédit mieux que le prix du marché.
 *   npm run journal:train
 */
import { writeFileSync } from "node:fs";
import { loadJournal, marketP, type Journal, type Row } from "./journal-data.ts";
import { FEATURES, PRIOR, featureVector, fitLogistic, predict } from "./journal-learn.ts";
import { clamp, meanSe, sideEv, tradePnl } from "./journal-model.ts";

const DIR = process.env.JOURNAL_DIR ?? "data/journal";
const STAKE = Number(process.env.JOURNAL_STAKE ?? 5);
const MIN_WINDOWS = 200;
const FOLDS = 5;
const LAMBDA = 5;

type Sample = { row: Row; x: number[]; y: number; q: number };

/**
 * Les relevés d'une fenêtre partagent un seul résultat : chaque fenêtre pèse 1
 * au total, pour que la pénalité et l'incertitude se comptent en fenêtres.
 */
function windowWeights(samples: Sample[]): number[] {
  const count = new Map<number, number>();
  for (const s of samples) count.set(s.row.window, (count.get(s.row.window) ?? 0) + 1);
  return samples.map((s) => 1 / (count.get(s.row.window) as number));
}

const logLoss = (p: number, y: number) => {
  const c = clamp(p, 1e-4, 1 - 1e-4);
  return -(y * Math.log(c) + (1 - y) * Math.log(1 - c));
};
const signed = (x: number, d = 4) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const pad = (s: string | number, n: number) => String(s).padStart(n);

function samplesFrom(rows: Row[]): Sample[] {
  const out: Sample[] = [];
  let prev: Row | null = null;
  for (const row of rows) {
    const x = featureVector(row, prev);
    const q = marketP(row);
    if (x && q != null) out.push({ row, x, y: row.up, q });
    prev = row;
  }
  return out;
}

/** Moyenne par fenêtre d'une perte, pour ne pas compter 19 fois la même fenêtre. */
function perWindow(samples: Sample[], loss: (s: Sample, i: number) => number): Map<number, number> {
  const acc = new Map<number, { s: number; n: number }>();
  samples.forEach((s, i) => {
    const a = acc.get(s.row.window) ?? { s: 0, n: 0 };
    a.s += loss(s, i);
    a.n += 1;
    acc.set(s.row.window, a);
  });
  return new Map([...acc].map(([w, a]) => [w, a.s / a.n]));
}

function compare(label: string, a: Map<number, number>, b: Map<number, number>) {
  const diffs = [...a.keys()].map((w) => (a.get(w) as number) - (b.get(w) as number));
  const s = meanSe(diffs);
  const verdict = s.mean + 2 * s.se < 0 ? "MEILLEUR" : s.mean - 2 * s.se > 0 ? "moins bon" : "pas de différence nette";
  console.log(`   ${label.padEnd(44)} ${signed(s.mean)} ± ${(2 * s.se).toFixed(4)}  → ${verdict}`);
  return { mean: s.mean, se: s.se, verdict };
}

function walkForward(samples: Sample[]) {
  const windows = [...new Set(samples.map((s) => s.row.window))].sort((a, b) => a - b);
  const chunk = Math.ceil(windows.length / FOLDS);
  const foldOf = new Map(windows.map((w, i) => [w, Math.floor(i / chunk)]));
  const test: Sample[] = [];
  const predFull: number[] = [];
  const predCalib: number[] = [];
  for (let f = 1; f < FOLDS; f++) {
    const train = samples.filter((s) => (foldOf.get(s.row.window) as number) < f);
    const now = samples.filter((s) => foldOf.get(s.row.window) === f);
    if (train.length === 0 || now.length === 0) continue;
    const weights = windowWeights(train);
    const full = fitLogistic(
      train.map((s) => s.x),
      train.map((s) => s.y),
      LAMBDA,
      PRIOR,
      weights,
    );
    const calib = fitLogistic(
      train.map((s) => s.x.slice(0, 2)),
      train.map((s) => s.y),
      LAMBDA,
      PRIOR.slice(0, 2),
      weights,
    );
    for (const s of now) {
      test.push(s);
      predFull.push(predict(full.beta, s.x));
      predCalib.push(predict(calib.beta, s.x.slice(0, 2)));
    }
  }
  return { test, predFull, predCalib };
}

function simulate(test: Sample[], preds: number[], minEdge: number) {
  const taken = new Set<number>();
  const pnls: number[] = [];
  let wins = 0;
  test.forEach((s, i) => {
    const r = s.row;
    if (taken.has(r.window) || r.upAsk == null || r.downAsk == null) return;
    const p = preds[i];
    const evUp = sideEv(p, r.upAsk, r.feeRate);
    const evDown = sideEv(1 - p, r.downAsk, r.feeRate);
    const buyUp = evUp >= evDown;
    if ((buyUp ? evUp : evDown) < minEdge) return;
    taken.add(r.window);
    const won = buyUp ? r.up === 1 : r.up === 0;
    if (won) wins += 1;
    pnls.push(tradePnl(buyUp ? r.upAsk : r.downAsk, won, STAKE, r.feeRate));
  });
  return { ...meanSe(pnls), wins, total: pnls.reduce((a, b) => a + b, 0) };
}

function main() {
  let journal: Journal;
  try {
    journal = loadJournal(DIR);
  } catch (error) {
    console.log(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }
  const samples = samplesFrom(journal.rows);
  const windows = new Set(samples.map((s) => s.row.window)).size;
  console.log(`Modèle appris · ${samples.length} observations complètes sur ${windows} fenêtres réglées.`);
  if (windows < MIN_WINDOWS) {
    console.log(
      `Il faut au moins ${MIN_WINDOWS} fenêtres avec le carnet et l'élan du BTC (le journal les note depuis cette version).\n` +
        "Laisse tourner le journal et relance plus tard.",
    );
    process.exitCode = 1;
    return;
  }

  // 1. Validation sur des fenêtres jamais vues : on entraîne sur le passé, on teste sur la suite.
  const { test, predFull, predCalib } = walkForward(samples);
  const market = perWindow(test, (s) => logLoss(s.q, s.y));
  const calib = perWindow(test, (s, i) => logLoss(predCalib[i], s.y));
  const full = perWindow(test, (s, i) => logLoss(predFull[i], s.y));
  const testWindows = market.size;
  console.log(`\n1) Hors échantillon (${testWindows} fenêtres jamais vues) · perte log, plus bas = meilleur`);
  const avg = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0) / m.size;
  console.log(`   marché seul ${avg(market).toFixed(4)} · marché recalibré ${avg(calib).toFixed(4)} · modèle appris ${avg(full).toFixed(4)}`);
  console.log("   Écart (négatif = le premier fait mieux) :");
  const vsMarket = compare("modèle appris − marché seul", full, market);
  compare("marché recalibré − marché seul", calib, market);
  compare("modèle appris − marché recalibré (signaux)", full, calib);

  // 2. Poids des signaux, sur toutes les données.
  const fit = fitLogistic(
    samples.map((s) => s.x),
    samples.map((s) => s.y),
    LAMBDA,
    PRIOR,
    windowWeights(samples),
  );
  console.log("\n2) Poids de chaque signal (modèle entraîné sur tout le journal)");
  console.log("   Signal                              poids    ± incertitude   ");
  FEATURES.forEach((f, j) => {
    const se = fit.se[j];
    const sure = Math.abs(fit.beta[j]) > 2 * se && j > 0 ? "  ← net" : "";
    console.log(`   ${f.label.padEnd(34)} ${pad(signed(fit.beta[j], 3), 7)}   ± ${(2 * se).toFixed(3)}${sure}`);
  });
  console.log(
    "   Lecture : « prix du marché » à 1 = marché bien calibré ; au-dessus, les favoris sont sous-cotés ;\n" +
      "   en dessous, les outsiders sont sous-cotés. Les autres : positif = pousse vers Up, négatif = vers Down.",
  );

  // 3. Trading simulé avec les seules prédictions hors échantillon.
  console.log(`\n3) Trading simulé hors échantillon · un achat par fenêtre, ${STAKE} $, frais compris (optimiste)`);
  console.log("   Écart minimum    trades   gagnés    P&L total    P&L / trade");
  for (const e of [0.02, 0.03, 0.05, 0.08]) {
    const s = simulate(test, predFull, e);
    if (s.n === 0) {
      console.log(`   ${pad(e * 100 + " c", 6)}           aucun trade`);
      continue;
    }
    const band = Number.isFinite(s.se) ? ` ± ${(2 * s.se).toFixed(2)}` : "";
    console.log(
      `   ${pad(e * 100 + " c", 6)}         ${pad(s.n, 6)}   ${pad(((s.wins / s.n) * 100).toFixed(1) + " %", 7)}   ${pad(signed(s.total, 2) + " $", 11)}    ${signed(s.mean, 2)} $${band}`,
    );
  }

  const file = `${DIR}/modele.json`;
  writeFileSync(
    file,
    JSON.stringify(
      {
        trainedAt: new Date().toISOString(),
        windows,
        samples: samples.length,
        features: FEATURES.map((f) => f.key),
        beta: fit.beta,
        outOfSample: { windows: testWindows, vsMarket },
      },
      null,
      2,
    ),
  );
  console.log(`\nModèle enregistré dans ${file}.`);
  console.log(
    vsMarket.verdict === "MEILLEUR"
      ? "Le modèle appris bat le marché sur des fenêtres jamais vues. Prochaine étape : le brancher sur le bot, en papier d'abord."
      : "Le modèle appris ne bat pas le marché sur des fenêtres jamais vues : ne le branche pas sur le bot.",
  );
}

main();
