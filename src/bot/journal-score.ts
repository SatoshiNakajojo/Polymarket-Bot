/**
 * Lit le journal et répond à une question : le modèle prédit-il mieux que le
 * prix du marché ? Puis simule quelques règles d'entrée, frais compris.
 *   npm run journal:score
 */
import { existsSync, readFileSync } from "node:fs";
import { brier, meanSe, sideEv, tradePnl } from "./journal-model.ts";

const DIR = process.env.JOURNAL_DIR ?? "data/journal";
const STAKE = Number(process.env.JOURNAL_STAKE ?? 5);

type Obs = {
  window: number;
  elapsed: number;
  pModel: number;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  feeRate: number;
  up: 0 | 1;
};

const num = (s: string | undefined) => (s == null || s === "" ? null : Number(s));

function load(): { rows: Obs[]; windows: number; resolved: number; agree: number; checked: number } {
  const obsFile = `${DIR}/observations.csv`;
  const outFile = `${DIR}/resultats.jsonl`;
  if (!existsSync(obsFile)) {
    throw new Error(`Journal introuvable dans ${DIR}/. Lance d'abord : npm run journal`);
  }
  if (!existsSync(outFile)) {
    throw new Error("Aucune fenêtre réglée pour l'instant. Laisse tourner le journal quelques minutes de plus.");
  }
  const outcomes = new Map<number, "Up" | "Down">();
  let agree = 0;
  let checked = 0;
  for (const line of readFileSync(outFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { window: number; outcome: "Up" | "Down"; journal_outcome: string | null };
      outcomes.set(r.window, r.outcome);
      if (r.journal_outcome) {
        checked += 1;
        if (r.journal_outcome === r.outcome) agree += 1;
      }
    } catch {
      /* ligne abîmée */
    }
  }
  const [head, ...lines] = readFileSync(obsFile, "utf8").split("\n");
  const col = new Map(head.split(",").map((name, i) => [name, i]));
  const get = (cells: string[], name: string) => cells[col.get(name) ?? -1];
  const rows: Obs[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = line.split(",");
    const window = Number(get(c, "window"));
    seen.add(window);
    const outcome = outcomes.get(window);
    const pModel = num(get(c, "p_model"));
    if (!outcome || pModel == null) continue;
    rows.push({
      window,
      elapsed: Number(get(c, "elapsed")),
      pModel,
      upBid: num(get(c, "up_bid")),
      upAsk: num(get(c, "up_ask")),
      downBid: num(get(c, "down_bid")),
      downAsk: num(get(c, "down_ask")),
      feeRate: Number(get(c, "fee_rate")) || 0.07,
      up: outcome === "Up" ? 1 : 0,
    });
  }
  return { rows, windows: seen.size, resolved: new Set(rows.map((r) => r.window)).size, agree, checked };
}

/** Milieu du carnet Up, si le carnet est lisible. */
function marketP(r: Obs): number | null {
  if (r.upBid == null || r.upAsk == null) return null;
  if (r.upAsk - r.upBid > 0.1) return null;
  return (r.upBid + r.upAsk) / 2;
}

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const pad = (s: string | number, n: number) => String(s).padStart(n);
const money = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} $`;

function phases() {
  return [
    [0, 60],
    [60, 120],
    [120, 180],
    [180, 240],
    [240, 300],
  ] as const;
}

const MIN_WINDOWS = 100;

function brierTable(rows: Obs[]) {
  console.log("\n1) Le modèle bat-il le marché ?  (score de Brier : plus bas = meilleur)");
  console.log("   Minute     fenêtres   modèle   marché   écart (modèle − marché)");
  for (const [a, b] of phases()) {
    // Une fenêtre donne plusieurs relevés liés entre eux : on moyenne par fenêtre.
    const perWindow = new Map<number, { m: number; k: number; n: number }>();
    for (const r of rows) {
      if (r.elapsed < a || r.elapsed >= b) continue;
      const q = marketP(r);
      if (q == null) continue;
      const acc = perWindow.get(r.window) ?? { m: 0, k: 0, n: 0 };
      acc.m += brier(r.pModel, r.up);
      acc.k += brier(q, r.up);
      acc.n += 1;
      perWindow.set(r.window, acc);
    }
    const list = [...perWindow.values()];
    const s = meanSe(list.map((w) => (w.m - w.k) / w.n));
    if (s.n < 2) {
      console.log(`   ${a / 60}–${b / 60} min   ${pad(s.n, 7)}   pas assez de données`);
      continue;
    }
    const sm = list.reduce((acc, w) => acc + w.m / w.n, 0) / s.n;
    const sk = list.reduce((acc, w) => acc + w.k / w.n, 0) / s.n;
    const verdict =
      s.n < MIN_WINDOWS
        ? `trop tôt (moins de ${MIN_WINDOWS} fenêtres)`
        : s.mean + 2 * s.se < 0
          ? "modèle MEILLEUR"
          : s.mean - 2 * s.se > 0
            ? "marché meilleur"
            : "pas de différence nette";
    console.log(
      `   ${a / 60}–${b / 60} min   ${pad(s.n, 7)}   ${sm.toFixed(4)}   ${sk.toFixed(4)}   ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(4)} ± ${(2 * s.se).toFixed(4)}  → ${verdict}`,
    );
  }
}

function calibration(rows: Obs[]) {
  console.log("\n2) Calibration : quand on annonce X %, Up sort-il X % du temps ?");
  console.log("   Annoncé      modèle (n → réel)      marché (n → réel)");
  for (let i = 0; i < 10; i++) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const inBin = (p: number) => p >= lo && (p < hi || (i === 9 && p <= 1));
    const m = rows.filter((r) => inBin(r.pModel));
    const k = rows.filter((r) => {
      const q = marketP(r);
      return q != null && inBin(q);
    });
    const rate = (xs: Obs[]) => (xs.length ? pct(xs.reduce((a, r) => a + r.up, 0) / xs.length) : "—");
    console.log(
      `   ${pad(i * 10, 2)}–${pad((i + 1) * 10, 3)} %    ${pad(m.length, 5)} → ${pad(rate(m), 7)}      ${pad(k.length, 5)} → ${pad(rate(k), 7)}`,
    );
  }
}

type Rule = { minEdge: number; maxEdge: number; maxPrice: number; from: number; to: number };
type Pick = { buyUp: boolean; ask: number } | null;

/** Le modèle achète le côté où son écart après frais est le plus grand. */
function modelPick(rule: Rule) {
  return (r: Obs): Pick => {
    if (r.elapsed < rule.from || r.elapsed >= rule.to) return null;
    if (r.upAsk == null || r.downAsk == null) return null;
    const evUp = sideEv(r.pModel, r.upAsk, r.feeRate);
    const evDown = sideEv(1 - r.pModel, r.downAsk, r.feeRate);
    const buyUp = evUp >= evDown;
    const ev = buyUp ? evUp : evDown;
    const ask = buyUp ? r.upAsk : r.downAsk;
    if (ev < rule.minEdge || ev > rule.maxEdge || ask > rule.maxPrice) return null;
    return { buyUp, ask };
  };
}

/** Sans modèle : le favori coûte entre lo et hi, on achète le favori ou l'outsider. */
function bandPick(lo: number, hi: number, side: "favori" | "outsider", from: number, to: number) {
  return (r: Obs): Pick => {
    if (r.elapsed < from || r.elapsed >= to) return null;
    if (r.upAsk == null || r.downAsk == null) return null;
    const upFavorite = r.upAsk >= r.downAsk;
    const favAsk = upFavorite ? r.upAsk : r.downAsk;
    if (favAsk < lo || favAsk >= hi) return null;
    const buyUp = side === "favori" ? upFavorite : !upFavorite;
    return { buyUp, ask: buyUp ? r.upAsk : r.downAsk };
  };
}

/** Première occasion de chaque fenêtre, au meilleur prix vendeur. */
function simulate(rows: Obs[], pick: (r: Obs) => Pick, stake: number) {
  const byWindow = new Map<number, Obs[]>();
  for (const r of rows) {
    const list = byWindow.get(r.window) ?? [];
    list.push(r);
    byWindow.set(r.window, list);
  }
  const pnls: number[] = [];
  let wins = 0;
  let priceSum = 0;
  for (const list of byWindow.values()) {
    list.sort((x, y) => x.elapsed - y.elapsed);
    for (const r of list) {
      const choice = pick(r);
      if (!choice) continue;
      const won = choice.buyUp ? r.up === 1 : r.up === 0;
      pnls.push(tradePnl(choice.ask, won, stake, r.feeRate));
      if (won) wins += 1;
      priceSum += choice.ask;
      break;
    }
  }
  return { ...meanSe(pnls), total: pnls.reduce((a, b) => a + b, 0), wins, avgPrice: pnls.length ? priceSum / pnls.length : 0 };
}

const RULE_HEADER = `   ${"Règle".padEnd(38)} trades  gagnés   prix    P&L total   P&L / trade`;

function printRule(label: string, rows: Obs[], pick: (r: Obs) => Pick) {
  const s = simulate(rows, pick, STAKE);
  if (s.n === 0) {
    console.log(`   ${label.padEnd(38)}  aucun trade`);
    return;
  }
  const band = Number.isFinite(s.se) ? ` ± ${(2 * s.se).toFixed(2)}` : "";
  const verdict =
    s.n < MIN_WINDOWS
      ? ""
      : s.mean - 2 * s.se > 0
        ? "  ← positif, à confirmer"
        : s.mean + 2 * s.se < 0
          ? "  ← perdant"
          : "";
  console.log(
    `   ${label.padEnd(38)} ${pad(s.n, 5)}  ${pad(pct(s.wins / s.n), 7)}  ${pad(Math.round(s.avgPrice * 100) + " c", 5)}  ${pad(money(s.total), 10)}  ${money(s.mean)}${band}${verdict}`,
  );
}

function simulations(rows: Obs[]) {
  console.log(`\n3) Simulation : un achat par fenêtre, ${STAKE} $ au meilleur prix vendeur, frais compris`);
  console.log("   (optimiste : en vrai, le prix part souvent avant que l'ordre arrive)");
  console.log(RULE_HEADER);
  const base = { maxEdge: 1, maxPrice: 0.99, from: 0, to: 300 };
  for (const e of [0.02, 0.03, 0.05, 0.08]) {
    printRule(`écart ≥ ${e * 100} c`, rows, modelPick({ ...base, minEdge: e }));
    printRule(`écart ${e * 100}–15 c, prix ≤ 80 c`, rows, modelPick({ ...base, minEdge: e, maxEdge: 0.15, maxPrice: 0.8 }));
  }
  console.log("\n   Par moment d'entrée (écart ≥ 5 c) :");
  for (const [a, b] of phases()) {
    printRule(`entrée ${a / 60}–${b / 60} min`, rows, modelPick({ ...base, minEdge: 0.05, from: a, to: b }));
  }
  console.log("\n4) Sans modèle : acheter le favori, ou l'outsider (= tout inverser), selon le prix du favori");
  console.log(RULE_HEADER);
  for (const [lo, hi] of [
    [0.75, 0.9],
    [0.9, 0.97],
    [0.97, 1],
  ] as const) {
    for (const [from, to] of [
      [30, 180],
      [180, 300],
    ] as const) {
      const when = `${from / 60 < 1 ? "0,5" : from / 60}–${to / 60} min`;
      const band = `${Math.round(lo * 100)}–${Math.min(99, Math.round(hi * 100))} c`;
      printRule(`favori ${band}, ${when}`, rows, bandPick(lo, hi, "favori", from, to));
      printRule(`outsider (fav. ${band}), ${when}`, rows, bandPick(lo, hi, "outsider", from, to));
    }
  }
}

function main() {
  let data: ReturnType<typeof load>;
  try {
    data = load();
  } catch (error) {
    console.log(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }
  const { rows, windows, resolved, agree, checked } = data;
  console.log(`Journal : ${windows} fenêtres observées, ${resolved} réglées, ${rows.length} observations utilisables.`);
  if (checked > 0) {
    console.log(
      `Reconstitution du résultat avec nos prix : ${agree}/${checked} identiques au résultat officiel (${pct(agree / checked)}).`,
    );
    if (agree / checked < 0.97) {
      console.log("  → Moins de 97 % : la source de prix du journal ne colle pas à celle de Polymarket. Méfiance sur le modèle.");
    }
  }
  if (resolved < 300) {
    console.log(`Encore peu de fenêtres (${resolved}). Vise au moins 500 avant de conclure (environ 2 jours).`);
  }
  brierTable(rows);
  calibration(rows);
  simulations(rows);
  console.log(
    "\nLecture : si le tableau 1 ne dit « modèle MEILLEUR » sur aucune minute, le modèle n'a pas d'avantage sur le marché\n" +
      "et aucun réglage du bot ne le rendra rentable en achetant au prix affiché.",
  );
}

main();
