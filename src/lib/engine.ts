/** Paper engine for Polymarket BTC 5-minute Up/Down windows. */

export const WINDOW_SEC = 300;
export const FEE_RATE = 0.07;
export const ENTRY_MIN_REMAINING = 20;
export const ENTRY_MAX_REMAINING = 110;
export const MAX_SPREAD = 0.08;

export type Side = "Up" | "Down";

export type Quote = {
  bid: number | null;
  ask: number | null;
  askSize: number | null;
};

export function windowStartSec(nowSec: number): number {
  return Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Abramowitz & Stegun 7.1.26, max error ~1.5e-7. */
export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * (ax / Math.SQRT2));
  const erf =
    sign *
    (1 -
      (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
        t *
        Math.exp(-(ax / Math.SQRT2) * (ax / Math.SQRT2))));
  return 0.5 * (1 + erf);
}

export function takerFeePerShare(price: number, rate = FEE_RATE): number {
  const p = clamp(price, 0, 1);
  return rate * p * (1 - p);
}

export type Fair = { pUp: number; breakeven: number; z: number };

/**
 * P(Up) that the window TWAP finishes at or above the opening price.
 * Remaining path is a driftless random walk; the uncertainty is on the
 * average of what's left, not on a single end print.
 */
export function fairUp(input: {
  strike: number;
  twap: number;
  price: number;
  elapsedSec: number;
  remainingSec: number;
  sigmaPerSqrtSec: number;
}): Fair {
  const elapsed = Math.max(0, input.elapsedSec);
  const remaining = Math.max(0, input.remainingSec);
  const total = elapsed + remaining;
  if (!(input.strike > 0) || !(input.price > 0) || total <= 0) {
    return { pUp: 0.5, breakeven: input.strike, z: 0 };
  }
  if (remaining < 1) {
    const up = input.twap >= input.strike;
    return { pUp: up ? 0.985 : 0.015, breakeven: input.price, z: up ? 3 : -3 };
  }
  const locked = input.twap * elapsed;
  const breakeven = (input.strike * total - locked) / remaining;
  const std = Math.max(0.5, input.sigmaPerSqrtSec * Math.sqrt(remaining / 3));
  const z = clamp((input.price - breakeven) / std, -6, 6);
  return { pUp: normalCdf(z), breakeven, z };
}

export type DecisionInput = {
  remainingSec: number;
  pUp: number;
  up: Quote;
  down: Quote;
  stakeUsd: number;
  minOrderSize: number;
  feeRate: number;
  minEdge: number;
  minRemaining: number;
  maxRemaining: number;
  maxSpread: number;
  lossHalted: boolean;
  alreadyIn: boolean;
  armed: boolean;
  marketState: "ready" | "missing" | "closed";
  cash: number;
  invert?: boolean;
  earlyPrice?: number;
};

export type Decision = {
  action: "buy" | "wait";
  side: Side | null;
  ask: number | null;
  shares: number | null;
  cost: number | null;
  fee: number | null;
  ev: number | null;
  reason: string;
};

function cents(x: number): string {
  const v = Math.round(x * 100);
  const sign = v > 0 ? "+" : "";
  return `${sign}${v} c`;
}

export function sideEv(prob: number, ask: number, feeRate: number): number {
  return prob - ask - takerFeePerShare(ask, feeRate);
}

export function bookProblem(up: Quote, down: Quote, maxSpread: number): string | null {
  if (up.ask == null || down.ask == null || up.bid == null || down.bid == null) {
    return "Carnet incomplet — pas d'achat.";
  }
  if (up.ask - up.bid > maxSpread || down.ask - down.bid > maxSpread) {
    return "Spread trop large — le carnet est illisible.";
  }
  if (Math.abs(up.ask + down.bid - 1) > 0.05 || Math.abs(down.ask + up.bid - 1) > 0.05) {
    return "Carnet incohérent avec son complément — on passe.";
  }
  return null;
}

export function decide(input: DecisionInput): Decision {
  const wait = (reason: string): Decision => ({
    action: "wait",
    side: null,
    ask: null,
    shares: null,
    cost: null,
    fee: null,
    ev: null,
    reason,
  });

  if (!input.armed) return wait("Bot en veille. Arme-le pour paper-trader.");
  if (input.marketState === "missing") return wait("Marché 5 min introuvable sur Polymarket.");
  if (input.marketState === "closed") return wait("Le carnet n'accepte plus d'ordres sur cette fenêtre.");
  if (input.lossHalted) return wait("Plafond de perte atteint. Réinitialise l'encaisse ou relève le plafond.");
  if (input.alreadyIn) return wait("Déjà engagé sur cette fenêtre. On tient jusqu'au règlement.");
  if (input.remainingSec < input.minRemaining) {
    return wait("Trop tard pour entrer. On laisse filer la fin de fenêtre.");
  }

  const upAskNow = input.up.ask;
  const downAskNow = input.down.ask;
  const level = input.earlyPrice ?? 0.75;
  const decisive =
    (upAskNow != null && upAskNow >= level) || (downAskNow != null && downAskNow >= level);
  const elapsed = 300 - input.remainingSec;
  const balancedWait = Math.max(120, 300 - input.maxRemaining);
  const needElapsed = decisive ? 30 : balancedWait;
  if (elapsed < needElapsed) {
    return wait(
      decisive
        ? "Direction déjà nette, encore quelques secondes."
        : "Encore autour de 50/50. On attend que le prix choisisse, ou la fin du délai.",
    );
  }

  const broken = bookProblem(input.up, input.down, input.maxSpread);
  if (broken) return wait(broken);

  const upAsk = input.up.ask as number;
  const downAsk = input.down.ask as number;
  const evUp = sideEv(input.pUp, upAsk, input.feeRate);
  const evDown = sideEv(1 - input.pUp, downAsk, input.feeRate);
  const pickUp = evUp >= evDown;
  const side: Side = pickUp ? "Up" : "Down";
  const ev = pickUp ? evUp : evDown;
  const ask = pickUp ? upAsk : downAsk;
  const label = side === "Up" ? "Up" : "Down";

  if (ev < input.minEdge) {
    return wait(
      `${label} à ${cents(ask).replace("+", "")}, écart ${cents(ev)} après frais — sous le seuil de ${cents(input.minEdge)}.`,
    );
  }

  let buySide = side;
  let buyAsk = ask;
  if (input.invert) {
    buySide = side === "Up" ? "Down" : "Up";
    buyAsk = buySide === "Up" ? upAsk : downAsk;
  }

  const shares = Math.floor((input.stakeUsd / buyAsk) * 100) / 100;
  const fee = shares * takerFeePerShare(buyAsk, input.feeRate);
  const cost = shares * buyAsk + fee;
  if (!(shares >= input.minOrderSize)) {
    return wait(
      `Mise trop petite : ${shares.toFixed(2)} parts, minimum du carnet ${input.minOrderSize}.`,
    );
  }
  if (cost > input.cash + 1e-9) {
    return wait("Encaisse papier insuffisante pour cette mise.");
  }

  const buyLabel = buySide === "Up" ? "Up" : "Down";
  return {
    action: "buy",
    side: buySide,
    ask: buyAsk,
    shares,
    cost,
    fee,
    ev,
    reason: input.invert
      ? `Achat inversé ${buyLabel} · le modèle voulait ${label}.`
      : `Achat ${buyLabel} · écart ${cents(ev)} après frais taker.`,
  };
}
