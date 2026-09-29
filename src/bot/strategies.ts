/**
 * Rejoue des stratégies sur les fenêtres du journal (un relevé toutes les 15 s).
 * Achat au meilleur prix vendeur, vente au meilleur prix acheteur, frais preneur
 * sur les deux. En mode « lent », chaque ordre s'exécute au relevé suivant.
 */
import { decide, fairUp, pairLock, PAIR_MIN, takerFeePerShare, type Side } from "@/lib/engine.ts";
import { marketP, type Row } from "./journal-data.ts";

export type Exec = "instant" | "lent";
export type WindowResult = { pnl: number; volume: number; legs: number };
export type Strategy = {
  key: string;
  label: string;
  run: (w: WindowRows, exec: Exec) => WindowResult | null;
};
export type WindowRows = { window: number; rows: Row[]; up: 0 | 1; previousUp: 0 | 1 | null };

const STAKE = 5;
const other = (s: Side): Side => (s === "Up" ? "Down" : "Up");
const askOf = (r: Row, s: Side) => (s === "Up" ? r.upAsk : r.downAsk);
const bidOf = (r: Row, s: Side) => (s === "Up" ? r.upBid : r.downBid);

type Leg = { side: Side; shares: number };

/** Petit carnet de compte d'une fenêtre. */
class Book {
  cash = 0;
  volume = 0;
  legs = 0;
  held: Leg[] = [];
  readonly w: WindowRows;
  readonly exec: Exec;
  constructor(w: WindowRows, exec: Exec) {
    this.w = w;
    this.exec = exec;
  }
  /** Relevé où l'ordre décidé au relevé i s'exécute. */
  at(i: number): Row | null {
    const j = this.exec === "lent" ? i + 1 : i;
    return this.w.rows.at(j) ?? null;
  }
  buy(i: number, side: Side, stake: number): Leg | null {
    const r = this.at(i);
    const ask = r ? askOf(r, side) : null;
    if (!r || ask == null || !(ask > 0) || ask >= 1) return null;
    const shares = stake / ask;
    this.cash -= stake + shares * takerFeePerShare(ask, r.feeRate);
    this.volume += stake;
    this.legs += 1;
    const leg = { side, shares };
    this.held.push(leg);
    return leg;
  }
  /** Achat d'un nombre de parts donné (pour la couverture du Double). */
  buyShares(i: number, side: Side, shares: number, ask: number): void {
    const r = this.at(i) as Row;
    this.cash -= shares * ask + shares * takerFeePerShare(ask, r.feeRate);
    this.volume += shares * ask;
    this.legs += 1;
    this.held.push({ side, shares });
  }
  sell(i: number, leg: Leg): boolean {
    const r = this.at(i);
    const bid = r ? bidOf(r, leg.side) : null;
    if (!r || bid == null || !(bid > 0)) return false;
    this.cash += leg.shares * bid - leg.shares * takerFeePerShare(bid, r.feeRate);
    this.volume += leg.shares * bid;
    this.legs += 1;
    this.held = this.held.filter((l) => l !== leg);
    return true;
  }
  settle(): WindowResult {
    const winner: Side = this.w.up === 1 ? "Up" : "Down";
    for (const leg of this.held) if (leg.side === winner) this.cash += leg.shares;
    return { pnl: this.cash, volume: this.volume, legs: this.legs };
  }
}

/** Décision du bot (ton moteur `decide`), au relevé i. */
export function botSide(w: WindowRows, i: number, invert: boolean): Side | null {
  const r = w.rows[i];
  if (r.spot == null || r.strike == null || r.sigma == null) return null;
  const seen = w.rows.slice(0, i + 1).map((x) => x.spot ?? r.spot ?? 0);
  const twap = (r.strike + seen.reduce((a, b) => a + b, 0)) / (seen.length + 1);
  const fair = fairUp({
    strike: r.strike,
    twap,
    price: r.spot,
    elapsedSec: r.elapsed,
    remainingSec: r.remaining,
    sigmaPerSqrtSec: Math.min(25, Math.max(3, r.sigma)),
  });
  const d = decide({
    remainingSec: r.remaining,
    pUp: fair.pUp,
    up: { bid: r.upBid, ask: r.upAsk, askSize: r.upSize },
    down: { bid: r.downBid, ask: r.downAsk, askSize: null },
    stakeUsd: STAKE,
    minOrderSize: 5,
    feeRate: r.feeRate,
    minEdge: 0.03,
    minRemaining: 20,
    maxRemaining: 300 - 3 * 60,
    maxSpread: 0.08,
    lossHalted: false,
    alreadyIn: false,
    armed: true,
    marketState: "ready",
    cash: Number.POSITIVE_INFINITY,
    invert,
    earlyPrice: 0.75,
  });
  return d.action === "buy" ? d.side : null;
}

function firstEntry(w: WindowRows, invert: boolean): { i: number; side: Side } | null {
  for (let i = 0; i < w.rows.length; i++) {
    const side = botSide(w, i, invert);
    if (side) return { i, side };
  }
  return null;
}

/** Le prix a-t-il traversé la référence, contre le côté tenu ? */
const crossed = (side: Side, spot: number | null, ref: number) =>
  spot != null && (side === "Up" ? spot < ref : spot > ref);

export type Reference = "entree" | "strike";

/**
 * Entrée du bot, puis au plus `maxFlips` retournements : vente, puis achat de
 * l'autre côté avec la mise multipliée par `factor`. factor 0 = simple stop.
 */
function stopFamily(
  invert: boolean,
  factor: number,
  maxFlips: number,
  ref: Reference,
  quietEnd = 0,
) {
  return (w: WindowRows, exec: Exec): WindowResult | null => {
    const entry = firstEntry(w, invert);
    return entry ? runStops(w, exec, entry, factor, maxFlips, ref, quietEnd) : null;
  };
}

/** Le cœur des stops et de la martingale, à partir d'une entrée donnée. */
export function runStops(
  w: WindowRows,
  exec: Exec,
  entry: { i: number; side: Side },
  factor: number,
  maxFlips: number,
  ref: Reference,
  quietEnd = 0,
): WindowResult | null {
  const book = new Book(w, exec);
  let leg = book.buy(entry.i, entry.side, STAKE);
  if (!leg) return null;
  let stake = STAKE;
  let flips = 0;
  let level = ref === "strike" ? (w.rows[entry.i].strike ?? 0) : (book.at(entry.i)?.spot ?? 0);
  for (let i = entry.i + 1; i < w.rows.length && leg; i++) {
    const r = w.rows[i];
    if (flips >= maxFlips || r.remaining < quietEnd) break;
    if (!crossed(leg.side, r.spot, level)) continue;
    if (!book.sell(i, leg)) continue;
    flips += 1;
    if (factor === 0) {
      leg = null;
      break;
    }
    stake *= factor;
    const next = book.buy(i, other(leg.side), stake);
    leg = next;
    if (ref === "entree") level = book.at(i)?.spot ?? level;
  }
  return book.settle();
}

function doubleLock(w: WindowRows, exec: Exec): WindowResult | null {
  const entry = firstEntry(w, false);
  if (!entry) return null;
  const book = new Book(w, exec);
  const first = book.buy(entry.i, entry.side, STAKE);
  const r0 = book.at(entry.i);
  const paid = r0 ? askOf(r0, entry.side) : null;
  if (!first || paid == null) return null;
  for (let i = entry.i + 1; i < w.rows.length; i++) {
    const r = book.at(i);
    const otherAsk = r ? askOf(r, other(entry.side)) : null;
    if (r && otherAsk != null && pairLock(paid, otherAsk, r.feeRate) >= PAIR_MIN) {
      book.buyShares(i, other(entry.side), first.shares, otherAsk);
      break;
    }
  }
  return book.settle();
}

/** Premier relevé qui satisfait `pick`, puis on tient jusqu'au règlement. */
function simple(pick: (r: Row, w: WindowRows, i: number) => Side | null) {
  return (w: WindowRows, exec: Exec): WindowResult | null => {
    for (let i = 0; i < w.rows.length; i++) {
      const side = pick(w.rows[i], w, i);
      if (!side) continue;
      const book = new Book(w, exec);
      if (!book.buy(i, side, STAKE)) return null;
      return book.settle();
    }
    return null;
  };
}

const favorite = (r: Row): Side | null =>
  r.upAsk == null || r.downAsk == null ? null : r.upAsk >= r.downAsk ? "Up" : "Down";

/** Entrée du bot, puis vente dès que le côté tenu vaut `target` ou plus. */
function takeProfit(target: number) {
  return (w: WindowRows, exec: Exec): WindowResult | null => {
    const entry = firstEntry(w, false);
    if (!entry) return null;
    const book = new Book(w, exec);
    const leg = book.buy(entry.i, entry.side, STAKE);
    if (!leg) return null;
    for (let i = entry.i + 1; i < w.rows.length; i++) {
      const bid = bidOf(w.rows[i], leg.side);
      if (bid != null && bid >= target && book.sell(i, leg)) break;
    }
    return book.settle();
  };
}

/**
 * Ordre limite au meilleur prix acheteur, sans frais preneur : rempli si le prix
 * vendeur descend jusqu'à lui. Pessimiste : on n'est rempli que si tout le
 * carnet a bougé contre nous, alors qu'en vrai un vendeur pressé peut suffire.
 */
function makerBid(at: number, side: "favori" | "outsider") {
  return (w: WindowRows): WindowResult | null => {
    const i0 = w.rows.findIndex((r) => r.elapsed >= at);
    if (i0 < 0) return null;
    const r0 = w.rows[i0];
    const fav = favorite(r0);
    if (!fav) return null;
    const s = side === "favori" ? fav : other(fav);
    const price = bidOf(r0, s);
    if (price == null || !(price > 0.02)) return null;
    for (let i = i0 + 1; i < w.rows.length; i++) {
      const ask = askOf(w.rows[i], s);
      if (ask != null && ask <= price + 1e-9) {
        const shares = STAKE / price;
        const won = (w.up === 1) === (s === "Up");
        return { pnl: (won ? shares : 0) - STAKE, volume: STAKE, legs: 1 };
      }
    }
    return null;
  };
}

export function strategies(): Strategy[] {
  const inBand = (r: Row, lo: number, hi: number) => {
    const fav = favorite(r);
    const a = fav ? askOf(r, fav) : null;
    return fav && a != null && a >= lo && a < hi ? fav : null;
  };
  return [
    // Les 6 du bureau
    { key: "direct", label: "Normal", run: simple((_, w, i) => botSide(w, i, false)) },
    { key: "inverse", label: "Inversé", run: simple((_, w, i) => botSide(w, i, true)) },
    { key: "stop", label: "Stop", run: stopFamily(false, 0, 1, "entree") },
    { key: "double", label: "Double", run: doubleLock },
    { key: "inverseStop", label: "Inversé + stop", run: stopFamily(true, 0, 1, "entree") },
    { key: "flip", label: "Stop x2 (une fois)", run: stopFamily(false, 2, 1, "entree") },
    // La martingale demandée
    {
      key: "mart-e3",
      label: "Martingale, réf. entrée, 3 max",
      run: stopFamily(false, 2, 3, "entree"),
    },
    {
      key: "mart-e9",
      label: "Martingale, réf. entrée, sans plafond",
      run: stopFamily(false, 2, 9, "entree"),
    },
    {
      key: "mart-s3",
      label: "Martingale, réf. prix à battre, 3 max",
      run: stopFamily(false, 2, 3, "strike"),
    },
    {
      key: "mart-s9",
      label: "Martingale, réf. prix à battre, sans plafond",
      run: stopFamily(false, 2, 9, "strike"),
    },
    {
      key: "mart-s3q",
      label: "Martingale, prix à battre, 3 max, calme 45 s",
      run: stopFamily(false, 2, 3, "strike", 45),
    },
    // Idées nouvelles
    {
      key: "lateFav",
      label: "Favori 90–97 c, dernière minute",
      run: simple((r) => (r.remaining <= 60 ? inBand(r, 0.9, 0.97) : null)),
    },
    {
      key: "lateFavTwap",
      label: "Favori tardif confirmé TWAP 60 s",
      run: simple((r) => {
        const fav = r.remaining <= 60 ? inBand(r, 0.85, 0.97) : null;
        if (!fav) return null;
        const p = fav === "Up" ? r.pModel : 1 - r.pModel;
        return p >= (askOf(r, fav) as number) + 0.02 ? fav : null;
      }),
    },
    {
      key: "outsiderTwap",
      label: "Outsider si TWAP 60 s le voit sous-coté",
      run: simple((r) => {
        const fav = r.elapsed >= 60 && r.remaining >= 60 ? inBand(r, 0.75, 0.9) : null;
        if (!fav) return null;
        const out = other(fav);
        const p = out === "Up" ? r.pModel : 1 - r.pModel;
        return p >= (askOf(r, out) as number) + 0.03 ? out : null;
      }),
    },
    { key: "tp95", label: "Normal + prise de bénéfice à 95 c", run: takeProfit(0.95) },
    {
      key: "flowFollow",
      label: "Suivre un saut du marché ≥ 6 c",
      run: simple((r, w, i) => {
        const prev = i > 0 ? w.rows[i - 1] : null;
        const q = marketP(r);
        const q0 = prev ? marketP(prev) : null;
        if (q == null || q0 == null || r.elapsed < 45 || r.remaining < 45) return null;
        return q - q0 >= 0.06 ? "Up" : q0 - q >= 0.06 ? "Down" : null;
      }),
    },
    {
      key: "flowFade",
      label: "Contrer un saut du marché ≥ 6 c",
      run: simple((r, w, i) => {
        const prev = i > 0 ? w.rows[i - 1] : null;
        const q = marketP(r);
        const q0 = prev ? marketP(prev) : null;
        if (q == null || q0 == null || r.elapsed < 45 || r.remaining < 45) return null;
        return q - q0 >= 0.06 ? "Down" : q0 - q >= 0.06 ? "Up" : null;
      }),
    },
    {
      key: "streak",
      label: "Rejouer le gagnant de la fenêtre d'avant",
      run: simple((r, w) =>
        r.elapsed >= 30 && w.previousUp != null ? (w.previousUp ? "Up" : "Down") : null,
      ),
    },
    {
      key: "antiStreak",
      label: "Contrer le gagnant de la fenêtre d'avant",
      run: simple((r, w) =>
        r.elapsed >= 30 && w.previousUp != null ? (w.previousUp ? "Down" : "Up") : null,
      ),
    },
    {
      key: "makerFav",
      label: "Ordre limite sur le favori (à 1 min)",
      run: (w) => makerBid(60, "favori")(w),
    },
    {
      key: "makerOut",
      label: "Ordre limite sur l'outsider (à 1 min)",
      run: (w) => makerBid(60, "outsider")(w),
    },
  ];
}

/** Regroupe les relevés par fenêtre, dans l'ordre. */
export function groupWindows(rows: Row[]): WindowRows[] {
  const map = new Map<number, Row[]>();
  for (const r of rows) {
    const list = map.get(r.window) ?? [];
    list.push(r);
    map.set(r.window, list);
  }
  const windows = [...map.keys()].sort((a, b) => a - b);
  const upOf = new Map(windows.map((w) => [w, (map.get(w) as Row[])[0].up]));
  return windows.map((w) => ({
    window: w,
    rows: (map.get(w) as Row[]).sort((a, b) => a.elapsed - b.elapsed),
    up: upOf.get(w) as 0 | 1,
    previousUp: upOf.get(w - 300) ?? null,
  }));
}
