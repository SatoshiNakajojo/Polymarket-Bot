/**
 * Teneur de marché papier pour une fenêtre BTC 5 min.
 *
 * Idée : poser un ordre d'achat au meilleur prix acheteur sur Up ET sur Down.
 * Comme Down ≈ 1 − Up, les deux meilleurs prix acheteurs font environ 99 c :
 * une paire Up + Down achetée ainsi paie 1 $ au règlement, quoi qu'il arrive,
 * sans frais preneur. Le risque : n'être exécuté que d'un côté, souvent juste
 * avant que le prix parte contre nous. D'où un plafond de déséquilibre.
 *
 * Remplissage simulé, prudent :
 * - on se place au bout de la file d'attente de notre prix ;
 * - une vente preneuse à notre prix consomme d'abord ceux devant nous ;
 * - une vente preneuse plus bas, ou un prix vendeur qui descend jusqu'à nous,
 *   nous remplit en entier (tout le niveau a été pris) ;
 * - une annulation à notre niveau ne nous fait avancer que si le niveau
 *   devient plus petit que la file devant nous.
 */
export type Side = "Up" | "Down";
export type Level = { price: number; size: number };

export type MakerParams = {
  /** Parts par ordre. */
  quoteSize: number;
  /** Déséquilibre maximal (parts Up − parts Down, en valeur absolue). */
  maxImbalance: number;
  /** Parts maximum achetées par côté dans une fenêtre. */
  maxPerSide: number;
  /** On ne cote plus quand il reste moins que ça (s). */
  stopBeforeEnd: number;
  /** On ne cote pas un côté dont le meilleur prix acheteur sort de [minPrice, maxPrice]. */
  minPrice: number;
  maxPrice: number;
  /** Écart acheteur/vendeur maximum pour coter. */
  maxSpread: number;
};

export const DEFAULT_PARAMS: MakerParams = {
  quoteSize: 10,
  maxImbalance: 10,
  maxPerSide: 100,
  stopBeforeEnd: 45,
  minPrice: 0.05,
  maxPrice: 0.95,
  maxSpread: 0.05,
};

type Book = { bids: Level[]; asks: Level[] };
type Order = { price: number; size: number; ahead: number; filled: number; placedAt: number };
export type Fill = { t: number; side: Side; price: number; shares: number; how: "file" | "balayage" | "croisement" };

export type MakerResult = {
  up: number;
  down: number;
  cost: number;
  payout: number;
  pnl: number;
  pairs: number;
  pairPnl: number;
  fills: number;
};

const other = (s: Side): Side => (s === "Up" ? "Down" : "Up");
const EPS = 1e-9;

export class MakerSim {
  readonly params: MakerParams;
  books: Record<Side, Book> = { Up: { bids: [], asks: [] }, Down: { bids: [], asks: [] } };
  orders: Record<Side, Order | null> = { Up: null, Down: null };
  shares: Record<Side, number> = { Up: 0, Down: 0 };
  cost: Record<Side, number> = { Up: 0, Down: 0 };
  fills: Fill[] = [];

  constructor(params: Partial<MakerParams> = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  bestBid(side: Side): number | null {
    return this.books[side].bids.reduce<number | null>((b, l) => (l.size > 0 && (b == null || l.price > b) ? l.price : b), null);
  }

  bestAsk(side: Side): number | null {
    return this.books[side].asks.reduce<number | null>((b, l) => (l.size > 0 && (b == null || l.price < b) ? l.price : b), null);
  }

  sizeAt(side: Side, price: number): number {
    return this.books[side].bids.find((l) => Math.abs(l.price - price) < EPS)?.size ?? 0;
  }

  /** Carnet complet d'un côté. */
  onBook(side: Side, bids: Level[], asks: Level[], t: number) {
    this.books[side] = { bids: [...bids], asks: [...asks] };
    const o = this.orders[side];
    if (o) o.ahead = Math.min(o.ahead, this.sizeAt(side, o.price));
    this.checkCross(side, t);
  }

  /** Changement d'un niveau (taille totale affichée à ce prix). */
  onLevel(side: Side, bookSide: "bid" | "ask", price: number, size: number, t: number) {
    const list = bookSide === "bid" ? this.books[side].bids : this.books[side].asks;
    const i = list.findIndex((l) => Math.abs(l.price - price) < EPS);
    if (size <= 0) {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) {
      list[i] = { price, size };
    } else {
      list.push({ price, size });
    }
    const o = this.orders[side];
    if (o && bookSide === "bid" && Math.abs(o.price - price) < EPS) o.ahead = Math.min(o.ahead, Math.max(0, size));
    if (bookSide === "ask") this.checkCross(side, t);
  }

  /** Transaction publique. `taker` = sens du preneur. */
  onTrade(side: Side, price: number, size: number, taker: "BUY" | "SELL", t: number) {
    const o = this.orders[side];
    if (!o || taker !== "SELL" || price > o.price + EPS) return;
    if (price < o.price - EPS) {
      this.fill(side, o.size - o.filled, t, "balayage");
      return;
    }
    const through = size - o.ahead;
    o.ahead = Math.max(0, o.ahead - size);
    if (through > EPS) this.fill(side, Math.min(through, o.size - o.filled), t, "file");
  }

  private checkCross(side: Side, t: number) {
    const o = this.orders[side];
    const ask = this.bestAsk(side);
    if (o && ask != null && ask <= o.price + EPS) this.fill(side, o.size - o.filled, t, "croisement");
  }

  private fill(side: Side, shares: number, t: number, how: Fill["how"]) {
    const o = this.orders[side];
    if (!o || !(shares > EPS)) return;
    o.filled += shares;
    this.shares[side] += shares;
    this.cost[side] += shares * o.price;
    this.fills.push({ t, side, price: o.price, shares, how });
    if (o.filled >= o.size - EPS) this.orders[side] = null;
  }

  avgCost(side: Side): number | null {
    return this.shares[side] > EPS ? this.cost[side] / this.shares[side] : null;
  }

  /** Recalcule les ordres. À appeler après chaque mise à jour du carnet. */
  requote(t: number, remaining: number) {
    const p = this.params;
    for (const side of ["Up", "Down"] as const) {
      const target = remaining < p.stopBeforeEnd ? null : this.target(side);
      const o = this.orders[side];
      if (target == null) {
        this.orders[side] = null;
        continue;
      }
      if (o && Math.abs(o.price - target) < EPS) continue;
      this.orders[side] = { price: target, size: p.quoteSize, ahead: this.sizeAt(side, target), filled: 0, placedAt: t };
      this.checkCross(side, t);
    }
  }

  /** Prix auquel coter ce côté, ou null pour ne pas coter. */
  target(side: Side): number | null {
    const p = this.params;
    const bid = this.bestBid(side);
    const ask = this.bestAsk(side);
    if (bid == null || ask == null) return null;
    if (bid < p.minPrice || bid > p.maxPrice || ask - bid > p.maxSpread + EPS) return null;
    const net = this.shares[side] - this.shares[other(side)];
    if (net >= p.maxImbalance - EPS || this.shares[side] >= p.maxPerSide - EPS) return null;
    // Côté en retard : ne jamais payer plus que ce qui garde la paire sous 1 $.
    const heavy = this.avgCost(other(side));
    if (net < -EPS && heavy != null) {
      const cap = Math.floor((1 - heavy - 0.001) * 100) / 100;
      if (cap < p.minPrice) return null;
      return Math.min(bid, cap);
    }
    return bid;
  }

  settle(winner: Side): MakerResult {
    const payout = this.shares[winner];
    const cost = this.cost.Up + this.cost.Down;
    const pairs = Math.min(this.shares.Up, this.shares.Down);
    const pairCost = pairs > EPS ? pairs * ((this.avgCost("Up") ?? 0) + (this.avgCost("Down") ?? 0)) : 0;
    return {
      up: this.shares.Up,
      down: this.shares.Down,
      cost,
      payout,
      pnl: payout - cost,
      pairs,
      pairPnl: pairs - pairCost,
      fills: this.fills.length,
    };
  }
}
