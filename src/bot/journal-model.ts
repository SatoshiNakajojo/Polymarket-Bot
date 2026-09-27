/**
 * Calculs purs du journal : modèle de règlement TWAP 60 s et outils de score.
 *
 * Depuis le 14 août 2026, un marché BTC Up/Down 5 min se règle ainsi :
 * Up si la TWAP Chainlink sur les 60 s qui finissent à la clôture est >= à la
 * TWAP Chainlink sur les 60 s qui précèdent l'ouverture (le « price to beat »).
 */

export const WINDOW_SEC = 300;
export const TWAP_SEC = 60;

export type Tick = { t: number; v: number };

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Abramowitz & Stegun 7.1.26. */
export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + (x < 0 ? -erf : erf));
}

/** Dernière valeur connue à l'instant t, si elle n'a pas plus de maxAge secondes. */
export function valueAt(ticks: Tick[], t: number, maxAge: number): number | null {
  for (let i = ticks.length - 1; i >= 0; i--) {
    const tick = ticks[i];
    if (tick.t <= t) return t - tick.t <= maxAge ? tick.v : null;
  }
  return null;
}

/** Moyenne pondérée dans le temps d'une série en escalier (triée) sur [a, b]. */
export function stepAverage(ticks: Tick[], a: number, b: number): number | null {
  if (!(b > a)) return null;
  let acc = 0;
  let covered = 0;
  for (let i = 0; i < ticks.length; i++) {
    const start = Math.max(ticks[i].t, a);
    const end = Math.min(i + 1 < ticks.length ? ticks[i + 1].t : b, b);
    if (end <= start) continue;
    acc += ticks[i].v * (end - start);
    covered += end - start;
  }
  if (covered < (b - a) * 0.8) return null;
  return acc / covered;
}

/**
 * P(Up) pour la règle TWAP 60 s. Prix en marche aléatoire sans dérive,
 * sigma en dollars par racine de seconde.
 * - Plus de 60 s restantes : la fenêtre finale n'a pas commencé.
 *   Var = sigma² × (R − 60) + sigma² × 60 / 3.
 * - Moins de 60 s : la partie écoulée de la fenêtre finale est acquise.
 */
export function fairUpTwap60(input: {
  strike: number;
  spot: number;
  lockedAvg: number | null;
  remainingSec: number;
  sigma: number;
}): { p: number; mean: number; std: number } {
  const r = clamp(input.remainingSec, 0, WINDOW_SEC);
  let mean: number;
  let std: number;
  if (r >= TWAP_SEC) {
    mean = input.spot;
    std = input.sigma * Math.sqrt(r - TWAP_SEC + TWAP_SEC / 3);
  } else {
    const locked = input.lockedAvg ?? input.spot;
    mean = (locked * (TWAP_SEC - r) + input.spot * r) / TWAP_SEC;
    std = (input.sigma * r * Math.sqrt(r / 3)) / TWAP_SEC;
  }
  if (!(std > 1e-9)) return { p: mean >= input.strike ? 0.999 : 0.001, mean, std };
  const p = clamp(normalCdf((mean - input.strike) / std), 0.001, 0.999);
  return { p, mean, std };
}

/** Volatilité en $/√s à partir de clôtures 1 min (rendements log). */
export function sigmaFromCloses(closes: number[]): number | null {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 20) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const last = closes[closes.length - 1];
  const sigma = (Math.sqrt(variance) / Math.sqrt(60)) * last;
  return Number.isFinite(sigma) && sigma > 0 ? sigma : null;
}

export function takerFeePerShare(price: number, rate: number): number {
  const p = clamp(price, 0, 1);
  return rate * p * (1 - p);
}

/** Espérance par part d'un achat au prix ask, frais preneur compris. */
export function sideEv(prob: number, ask: number, rate: number): number {
  return prob - ask - takerFeePerShare(ask, rate);
}

/** P&L d'un achat de `stake` dollars au prix ask, frais compris. */
export function tradePnl(ask: number, won: boolean, stake: number, rate: number): number {
  const shares = stake / ask;
  const fee = shares * takerFeePerShare(ask, rate);
  return (won ? shares - stake : -stake) - fee;
}

export function brier(p: number, y: number): number {
  return (p - y) ** 2;
}

export function meanSe(xs: number[]): { mean: number; se: number; n: number } {
  const n = xs.length;
  if (n === 0) return { mean: Number.NaN, se: Number.NaN, n };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, se: Number.NaN, n };
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, se: Math.sqrt(variance / n), n };
}
