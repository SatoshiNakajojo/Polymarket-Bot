/**
 * Modèle appris : part du prix du marché et cherche si l'élan du BTC et le
 * carnet Polymarket permettent de le corriger. Régression logistique pure.
 */
import { marketP, type Row } from "./journal-data.ts";
import { clamp } from "./journal-model.ts";

export const FEATURES = [
  { key: "bias", label: "constante" },
  { key: "market", label: "prix du marché (logit)" },
  { key: "twap", label: "écart modèle TWAP − marché" },
  { key: "mom15", label: "élan BTC 15 s" },
  { key: "mom60", label: "élan BTC 1 min" },
  { key: "mom300", label: "élan BTC 5 min" },
  { key: "imbTop", label: "déséquilibre au meilleur prix" },
  { key: "imbDepth", label: "déséquilibre profondeur 3 c" },
  { key: "flow", label: "variation du prix marché 15 s" },
] as const;

export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function imbalance(a: number | null, b: number | null): number | null {
  if (a == null || b == null || !(a + b > 0)) return null;
  return (a - b) / (a + b);
}

/** Rendement ramené à la volatilité attendue sur k secondes. */
export function momentum(ret: number | null, row: Row, k: number): number | null {
  if (ret == null || row.sigma == null || row.spot == null || !(row.spot > 0)) return null;
  const scale = (row.sigma / row.spot) * Math.sqrt(k);
  return scale > 0 ? clamp(ret / scale, -5, 5) : null;
}

/**
 * Signaux d'une observation. `prev` est l'observation précédente de la même
 * fenêtre (15 s plus tôt). Renvoie null si une donnée manque.
 */
export function featureVector(row: Row, prev: Row | null): number[] | null {
  const q = marketP(row);
  if (q == null) return null;
  const market = logit(clamp(q, 0.02, 0.98));
  const twap = clamp(logit(clamp(row.pModel, 0.001, 0.999)) - market, -4, 4);
  const mom15 = momentum(row.ret15, row, 15);
  const mom60 = momentum(row.ret60, row, 60);
  const mom300 = momentum(row.ret300, row, 300);
  const imbTop = imbalance(row.upBidSize, row.upSize);
  const imbDepth = imbalance(row.upBidDepth, row.upAskDepth);
  if (mom15 == null || mom60 == null || mom300 == null || imbTop == null || imbDepth == null) return null;
  const prevQ = prev && prev.window === row.window && row.elapsed - prev.elapsed <= 20 ? marketP(prev) : null;
  const flow = prevQ == null ? 0 : market - logit(clamp(prevQ, 0.02, 0.98));
  // Un signal qui annonce un mouvement pèse plus quand il reste peu de temps
  // (son effet sur la probabilité varie comme 1/√temps restant).
  const urgency = Math.sqrt(300 / Math.max(row.remaining, 15));
  return [
    1,
    market,
    twap,
    mom15 * urgency,
    mom60 * urgency,
    mom300 * urgency,
    imbTop * urgency,
    imbDepth * urgency,
    flow,
  ];
}

export type Fit = { beta: number[]; se: number[] };

/** Résout A x = b (pivot partiel). A est modifiée. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    const d = a[col][col] || 1e-12;
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / (a[r][r] || 1e-12);
  }
  return x;
}

/** A priori : le marché est juste (poids 1 sur son prix), les signaux valent zéro. */
export const PRIOR = FEATURES.map((f) => (f.key === "market" ? 1 : 0));

/**
 * Régression logistique par Newton (IRLS). Pénalité L2 `lambda` qui tire
 * chaque poids (sauf la constante) vers `prior`. `weights` pondère chaque
 * observation. `se` vient de l'inverse du hessien.
 */
export function fitLogistic(
  x: number[][],
  y: number[],
  lambda = 1,
  prior?: number[],
  weights?: number[],
  iterations = 25,
): Fit {
  const k = x[0]?.length ?? 0;
  const mu = prior ?? new Array<number>(k).fill(0);
  let beta = [...mu];
  let hessian: number[][] = [];
  for (let it = 0; it < iterations; it++) {
    const grad = new Array<number>(k).fill(0);
    hessian = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      let z = 0;
      for (let j = 0; j < k; j++) z += beta[j] * xi[j];
      const p = sigmoid(z);
      const weight = weights?.[i] ?? 1;
      const w = Math.max(p * (1 - p), 1e-9) * weight;
      for (let j = 0; j < k; j++) {
        grad[j] += weight * (y[i] - p) * xi[j];
        for (let l = j; l < k; l++) hessian[j][l] += w * xi[j] * xi[l];
      }
    }
    for (let j = 0; j < k; j++) {
      for (let l = 0; l < j; l++) hessian[j][l] = hessian[l][j];
      if (j > 0) {
        hessian[j][j] += lambda;
        grad[j] -= lambda * (beta[j] - mu[j]);
      }
    }
    const step = solve(
      hessian.map((r) => [...r]),
      [...grad],
    );
    beta = beta.map((b, j) => b + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const se = new Array<number>(k).fill(0).map((_, j) => {
    const e = new Array<number>(k).fill(0);
    e[j] = 1;
    return Math.sqrt(Math.max(0, solve(hessian.map((r) => [...r]), e)[j]));
  });
  return { beta, se };
}

export function predict(beta: number[], features: number[]): number {
  let z = 0;
  for (let j = 0; j < beta.length; j++) z += beta[j] * features[j];
  return sigmoid(z);
}
