/**
 * IA du journal : deux modèles plus puissants que la régression logistique,
 * entraînés sur le cours du BTC et le carnet Polymarket, puis jugés sur des
 * fenêtres qu'ils n'ont jamais vues, contre le prix du marché.
 *
 * - « Arbres » : arbres de décision combinés (gradient boosting, comme
 *   XGBoost), qui trouvent seuls les combinaisons de signaux.
 * - « Réseau » : petit réseau de neurones (16 neurones cachés).
 *
 * Les deux partent du prix du marché et n'apprennent qu'une correction : sans
 * signal réel, ils restent collés au marché au lieu d'inventer.
 * Aucun appel réseau, aucun ordre : calcul pur.
 */
import { marketP, type Row } from "./journal-data.ts";
import { imbalance, logit, momentum, sigmoid } from "./journal-learn.ts";
import { clamp, meanSe, sideEv, tradePnl } from "./journal-model.ts";

export const IA_FEATURES = [
  "prix du marché",
  "écart modèle TWAP − marché",
  "élan BTC 15 s",
  "élan BTC 1 min",
  "élan BTC 5 min",
  "déséquilibre au meilleur prix",
  "déséquilibre profondeur 3 c",
  "variation du prix marché 15 s",
  "temps restant",
  "écart achat/vente Up",
  "distance au prix à battre",
  "quantités en vente Up − Down",
] as const;

export type IaSample = {
  window: number;
  elapsed: number;
  x: number[];
  y: 0 | 1;
  /** Prix du marché (milieu du carnet Up). */
  q: number;
  upAsk: number | null;
  downAsk: number | null;
  upSize: number | null;
  downSize: number | null;
  feeRate: number;
};

/** Signaux bruts d'une observation (l'IA trouve seule les combinaisons). */
export function iaFeatures(row: Row, prev: Row | null): number[] | null {
  const q = marketP(row);
  if (q == null || row.upBid == null || row.upAsk == null) return null;
  const market = logit(clamp(q, 0.02, 0.98));
  const mom15 = momentum(row.ret15, row, 15);
  const mom60 = momentum(row.ret60, row, 60);
  const mom300 = momentum(row.ret300, row, 300);
  const imbTop = imbalance(row.upBidSize, row.upSize);
  const imbDepth = imbalance(row.upBidDepth, row.upAskDepth);
  const imbAsks = imbalance(row.upSize, row.downSize);
  if (mom15 == null || mom60 == null || mom300 == null || imbTop == null || imbDepth == null || imbAsks == null) {
    return null;
  }
  if (row.spot == null || row.strike == null || row.sigma == null || !(row.sigma > 0)) return null;
  const prevQ = prev && prev.window === row.window && row.elapsed - prev.elapsed <= 20 ? marketP(prev) : null;
  const flow = prevQ == null ? 0 : market - logit(clamp(prevQ, 0.02, 0.98));
  const distance = clamp((row.spot - row.strike) / (row.sigma * Math.sqrt(Math.max(row.remaining, 15))), -6, 6);
  return [
    market,
    clamp(logit(clamp(row.pModel, 0.001, 0.999)) - market, -4, 4),
    mom15,
    mom60,
    mom300,
    imbTop,
    imbDepth,
    flow,
    row.remaining / 300,
    row.upAsk - row.upBid,
    distance,
    imbAsks,
  ];
}

export function iaSamples(rows: Row[]): IaSample[] {
  const out: IaSample[] = [];
  let prev: Row | null = null;
  for (const row of rows) {
    const x = iaFeatures(row, prev);
    const q = marketP(row);
    if (x && q != null) {
      out.push({
        window: row.window,
        elapsed: row.elapsed,
        x,
        y: row.up,
        q,
        upAsk: row.upAsk,
        downAsk: row.downAsk,
        upSize: row.upSize,
        downSize: row.downSize,
        feeRate: row.feeRate,
      });
    }
    prev = row;
  }
  return out;
}

/* ---------- outils ---------- */

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const offsetOf = (s: IaSample) => logit(clamp(s.q, 0.02, 0.98));

/** Chaque fenêtre pèse 1 au total : ses ~19 relevés partagent un seul résultat. */
function windowWeights(samples: IaSample[]): Float64Array {
  const count = new Map<number, number>();
  for (const s of samples) count.set(s.window, (count.get(s.window) ?? 0) + 1);
  return Float64Array.from(samples, (s) => 1 / (count.get(s.window) as number));
}

export function logLoss(p: number, y: number): number {
  const c = clamp(p, 1e-4, 1 - 1e-4);
  return -(y * Math.log(c) + (1 - y) * Math.log(1 - c));
}

function weightedLoss(z: Float64Array, samples: IaSample[], w: Float64Array): number {
  let s = 0;
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    s += w[i] * logLoss(sigmoid(z[i]), samples[i].y);
    total += w[i];
  }
  return total > 0 ? s / total : 0;
}

/** Coupe chronologique : les dernières fenêtres servent à savoir quand arrêter d'apprendre. */
function splitByTime(samples: IaSample[], share: number): [IaSample[], IaSample[]] {
  const windows = [...new Set(samples.map((s) => s.window))].sort((a, b) => a - b);
  const cut = windows[Math.floor(windows.length * (1 - share))] ?? Number.POSITIVE_INFINITY;
  return [samples.filter((s) => s.window < cut), samples.filter((s) => s.window >= cut)];
}

export interface Model {
  /** Probabilité de Up. */
  predict(s: IaSample): number;
  /** Combien de tours (arbres) ou d'époques (réseau) ont été gardés. */
  steps: number;
}

/* ---------- arbres de décision combinés ---------- */

export type TreeParams = {
  depth: number;
  rounds: number;
  patience: number;
  eta: number;
  lambda: number;
  /** Poids minimal d'une feuille (≈ fenêtres × 0,25). */
  minLeaf: number;
  bins: number;
};

export const TREE_DEFAULTS: TreeParams = {
  depth: 3,
  rounds: 400,
  patience: 50,
  eta: 0.05,
  lambda: 1,
  minLeaf: 2,
  bins: 32,
};

type Tree = { feat: Int16Array; cut: Uint8Array; leaf: Float64Array };

function cutPoints(samples: IaSample[], j: number, bins: number): number[] {
  const step = Math.max(1, Math.floor(samples.length / 20_000));
  const values: number[] = [];
  for (let i = 0; i < samples.length; i += step) values.push(samples[i].x[j]);
  values.sort((a, b) => a - b);
  const cuts: number[] = [];
  for (let b = 1; b < bins; b++) {
    const v = values[Math.floor((b / bins) * values.length)];
    if (v !== undefined && (cuts.length === 0 || v > cuts[cuts.length - 1])) cuts.push(v);
  }
  return cuts;
}

/** Indice de case : nombre de seuils strictement sous la valeur. */
function binOf(cuts: number[], v: number): number {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v > cuts[mid]) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function binAll(samples: IaSample[], cuts: number[][]): Uint8Array {
  const k = cuts.length;
  const out = new Uint8Array(samples.length * k);
  samples.forEach((s, i) => {
    for (let j = 0; j < k; j++) out[i * k + j] = binOf(cuts[j], s.x[j]);
  });
  return out;
}

function treeValue(tree: Tree, bins: Uint8Array, i: number, k: number, depth: number): number {
  let node = 0;
  for (let d = 0; d < depth; d++) {
    const at = (1 << d) - 1 + node;
    const f = tree.feat[at];
    node = 2 * node + (f >= 0 && bins[i * k + f] > tree.cut[at] ? 1 : 0);
  }
  return tree.leaf[node];
}

function growTree(
  bins: Uint8Array,
  g: Float64Array,
  h: Float64Array,
  n: number,
  k: number,
  p: TreeParams,
  gains: Float64Array,
): Tree {
  const B = p.bins + 1;
  const internal = (1 << p.depth) - 1;
  const tree: Tree = {
    feat: new Int16Array(internal).fill(-1),
    cut: new Uint8Array(internal),
    leaf: new Float64Array(1 << p.depth),
  };
  const node = new Int32Array(n);
  for (let d = 0; d < p.depth; d++) {
    const width = 1 << d;
    const G = new Float64Array(width * k * B);
    const H = new Float64Array(width * k * B);
    for (let i = 0; i < n; i++) {
      const base = node[i] * k * B;
      for (let j = 0; j < k; j++) {
        const idx = base + j * B + bins[i * k + j];
        G[idx] += g[i];
        H[idx] += h[i];
      }
    }
    for (let m = 0; m < width; m++) {
      let gTot = 0;
      let hTot = 0;
      for (let b = 0; b < B; b++) {
        gTot += G[m * k * B + b];
        hTot += H[m * k * B + b];
      }
      const parent = (gTot * gTot) / (hTot + p.lambda);
      let best = 1e-9;
      let bestF = -1;
      let bestCut = 0;
      for (let j = 0; j < k; j++) {
        let gl = 0;
        let hl = 0;
        const off = m * k * B + j * B;
        for (let b = 0; b < B - 1; b++) {
          gl += G[off + b];
          hl += H[off + b];
          const gr = gTot - gl;
          const hr = hTot - hl;
          if (hl < p.minLeaf || hr < p.minLeaf) continue;
          const gain = (gl * gl) / (hl + p.lambda) + (gr * gr) / (hr + p.lambda) - parent;
          if (gain > best) {
            best = gain;
            bestF = j;
            bestCut = b;
          }
        }
      }
      const at = width - 1 + m;
      tree.feat[at] = bestF;
      tree.cut[at] = bestCut;
      if (bestF >= 0) gains[bestF] += best;
    }
    for (let i = 0; i < n; i++) {
      const at = width - 1 + node[i];
      const f = tree.feat[at];
      node[i] = 2 * node[i] + (f >= 0 && bins[i * k + f] > tree.cut[at] ? 1 : 0);
    }
  }
  const G = new Float64Array(1 << p.depth);
  const H = new Float64Array(1 << p.depth);
  for (let i = 0; i < n; i++) {
    G[node[i]] += g[i];
    H[node[i]] += h[i];
  }
  for (let l = 0; l < G.length; l++) tree.leaf[l] = (-p.eta * G[l]) / (H[l] + p.lambda);
  return tree;
}

export function trainTrees(
  samples: IaSample[],
  params: Partial<TreeParams> = {},
): Model & { importance: number[] } {
  const p = { ...TREE_DEFAULTS, ...params };
  const [fit, val] = splitByTime(samples, 0.2);
  const k = samples[0]?.x.length ?? 0;
  const cuts = Array.from({ length: k }, (_, j) => cutPoints(fit, j, p.bins));
  const bFit = binAll(fit, cuts);
  const bVal = binAll(val, cuts);
  const wFit = windowWeights(fit);
  const wVal = windowWeights(val);
  const zFit = Float64Array.from(fit, offsetOf);
  const zVal = Float64Array.from(val, offsetOf);
  const g = new Float64Array(fit.length);
  const h = new Float64Array(fit.length);
  const trees: Tree[] = [];
  const gains: Float64Array[] = [];
  let bestLoss = weightedLoss(zVal, val, wVal);
  let bestRounds = 0;
  for (let r = 0; r < p.rounds && fit.length > 0; r++) {
    for (let i = 0; i < fit.length; i++) {
      const prob = sigmoid(zFit[i]);
      g[i] = wFit[i] * (prob - fit[i].y);
      h[i] = wFit[i] * Math.max(prob * (1 - prob), 1e-6);
    }
    const gain = new Float64Array(k);
    const tree = growTree(bFit, g, h, fit.length, k, p, gain);
    trees.push(tree);
    gains.push(gain);
    for (let i = 0; i < fit.length; i++) zFit[i] += treeValue(tree, bFit, i, k, p.depth);
    for (let i = 0; i < val.length; i++) zVal[i] += treeValue(tree, bVal, i, k, p.depth);
    const loss = val.length ? weightedLoss(zVal, val, wVal) : 0;
    if (loss < bestLoss - 1e-7) {
      bestLoss = loss;
      bestRounds = r + 1;
    } else if (r + 1 - bestRounds >= p.patience) {
      break;
    }
  }
  const kept = trees.slice(0, bestRounds);
  const importance = new Array<number>(k).fill(0);
  for (const gain of gains.slice(0, bestRounds)) gain.forEach((v, j) => (importance[j] += v));
  const sum = importance.reduce((a, b) => a + b, 0);
  return {
    steps: bestRounds,
    importance: importance.map((v) => (sum > 0 ? v / sum : 0)),
    predict(s) {
      const one = Uint8Array.from(cuts, (c, j) => binOf(c, s.x[j]));
      let z = offsetOf(s);
      for (const t of kept) z += treeValue(t, one, 0, k, p.depth);
      return sigmoid(z);
    },
  };
}

/* ---------- petit réseau de neurones ---------- */

export type NetParams = {
  hidden: number;
  epochs: number;
  patience: number;
  rate: number;
  batch: number;
  decay: number;
  seed: number;
};

export const NET_DEFAULTS: NetParams = {
  hidden: 16,
  epochs: 80,
  patience: 10,
  rate: 0.003,
  batch: 512,
  decay: 1e-3,
  seed: 1,
};

type Net = { w1: Float64Array; b1: Float64Array; w2: Float64Array; b2: number };

export function trainNet(samples: IaSample[], params: Partial<NetParams> = {}): Model {
  const p = { ...NET_DEFAULTS, ...params };
  const rand = rng(p.seed);
  const [fit, val] = splitByTime(samples, 0.2);
  const k = samples[0]?.x.length ?? 0;
  const H = p.hidden;
  // Chaque signal est ramené à moyenne 0, écart-type 1 (sur les données d'entraînement).
  const mean = new Array<number>(k).fill(0);
  const std = new Array<number>(k).fill(1);
  for (let j = 0; j < k; j++) {
    const xs = fit.map((s) => s.x[j]);
    const m = xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(xs.length - 1, 1);
    mean[j] = m;
    std[j] = Math.sqrt(v) > 1e-9 ? Math.sqrt(v) : 1;
  }
  const norm = (s: IaSample) => Float64Array.from(s.x, (v, j) => (v - mean[j]) / std[j]);
  const zFit = fit.map(norm);
  const zVal = val.map(norm);
  const wFit = windowWeights(fit);
  const wVal = windowWeights(val);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  // Sortie à zéro au départ : le réseau commence exactement au prix du marché.
  const net: Net = {
    w1: Float64Array.from({ length: H * k }, () => gauss() / Math.sqrt(k)),
    b1: new Float64Array(H),
    w2: new Float64Array(H),
    b2: 0,
  };
  const hiddenOut = new Float64Array(H);
  const forward = (n: Net, z: Float64Array, offset: number) => {
    let out = offset + n.b2;
    for (let u = 0; u < H; u++) {
      let a = n.b1[u];
      for (let j = 0; j < k; j++) a += n.w1[u * k + j] * z[j];
      hiddenOut[u] = Math.tanh(a);
      out += n.w2[u] * hiddenOut[u];
    }
    return out;
  };
  const valLoss = (n: Net) => {
    const z = Float64Array.from(val, (s, i) => forward(n, zVal[i], offsetOf(s)));
    return weightedLoss(z, val, wVal);
  };
  const clone = (n: Net): Net => ({ w1: n.w1.slice(), b1: n.b1.slice(), w2: n.w2.slice(), b2: n.b2 });
  // Adam.
  const size = H * k + H + H + 1;
  const m1 = new Float64Array(size);
  const m2 = new Float64Array(size);
  const grad = new Float64Array(size);
  let step = 0;
  const update = () => {
    step += 1;
    const c1 = 1 - 0.9 ** step;
    const c2 = 1 - 0.999 ** step;
    let idx = 0;
    const apply = (arr: Float64Array, decay: boolean) => {
      for (let i = 0; i < arr.length; i++, idx++) {
        const gr = grad[idx] + (decay ? p.decay * arr[i] : 0);
        m1[idx] = 0.9 * m1[idx] + 0.1 * gr;
        m2[idx] = 0.999 * m2[idx] + 0.001 * gr * gr;
        arr[i] -= (p.rate * (m1[idx] / c1)) / (Math.sqrt(m2[idx] / c2) + 1e-8);
      }
    };
    apply(net.w1, true);
    apply(net.b1, false);
    apply(net.w2, true);
    const gr = grad[idx];
    m1[idx] = 0.9 * m1[idx] + 0.1 * gr;
    m2[idx] = 0.999 * m2[idx] + 0.001 * gr * gr;
    net.b2 -= (p.rate * (m1[idx] / c1)) / (Math.sqrt(m2[idx] / c2) + 1e-8);
  };
  let best = clone(net);
  let bestLoss = val.length ? valLoss(net) : 0;
  let bestEpoch = 0;
  const order = Array.from(fit, (_, i) => i);
  for (let epoch = 0; epoch < p.epochs && fit.length > 0; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let start = 0; start < order.length; start += p.batch) {
      const batch = order.slice(start, start + p.batch);
      let wSum = 0;
      for (const i of batch) wSum += wFit[i];
      grad.fill(0);
      for (const i of batch) {
        const z = zFit[i];
        const out = forward(net, z, offsetOf(fit[i]));
        const d = (wFit[i] * (sigmoid(out) - fit[i].y)) / wSum;
        for (let u = 0; u < H; u++) {
          const a = hiddenOut[u];
          const da = d * net.w2[u] * (1 - a * a);
          for (let j = 0; j < k; j++) grad[u * k + j] += da * z[j];
          grad[H * k + u] += da;
          grad[H * k + H + u] += d * a;
        }
        grad[size - 1] += d;
      }
      update();
    }
    const loss = val.length ? valLoss(net) : 0;
    if (loss < bestLoss - 1e-7) {
      bestLoss = loss;
      best = clone(net);
      bestEpoch = epoch + 1;
    } else if (epoch + 1 - bestEpoch >= p.patience) {
      break;
    }
  }
  return {
    steps: bestEpoch,
    predict(s) {
      return sigmoid(forward(best, norm(s), offsetOf(s)));
    },
  };
}

/* ---------- jugement sur des fenêtres jamais vues ---------- */

export type Comparison = { mean: number; se: number; verdict: "MEILLEUR" | "moins bon" | "pas de différence nette" };
export type Trading = {
  ecart: number;
  execution: "immédiate" | "15 s plus tard";
  trades: number;
  gagnes: number;
  total: number;
  moyenne: number;
  incertitude: number | null;
};
export type ModelReport = {
  cle: "arbres" | "reseau";
  nom: string;
  perteModele: number;
  perteMarche: number;
  ecart: Comparison;
  trading: Trading[];
  etapes: number[];
  importance: { signal: string; part: number }[] | null;
  bat: boolean;
};

export const EDGES = [0.02, 0.03, 0.05, 0.08];
/** Écart retenu pour le verdict, fixé d'avance (pas choisi après coup). */
export const VERDICT_EDGE = 0.03;

/** Moyenne par fenêtre d'une perte : 19 relevés d'une fenêtre ne comptent qu'une fois. */
function perWindow(samples: IaSample[], loss: (s: IaSample, i: number) => number): Map<number, number> {
  const acc = new Map<number, { s: number; n: number }>();
  samples.forEach((s, i) => {
    const a = acc.get(s.window) ?? { s: 0, n: 0 };
    a.s += loss(s, i);
    a.n += 1;
    acc.set(s.window, a);
  });
  return new Map([...acc].map(([w, a]) => [w, a.s / a.n]));
}

export function compare(a: Map<number, number>, b: Map<number, number>): Comparison {
  const s = meanSe([...a.keys()].map((w) => (a.get(w) as number) - (b.get(w) as number)));
  const se = Number.isFinite(s.se) ? s.se : 0;
  const verdict = s.mean + 2 * se < 0 ? "MEILLEUR" : s.mean - 2 * se > 0 ? "moins bon" : "pas de différence nette";
  return { mean: s.mean, se, verdict };
}

/**
 * Un achat au plus par fenêtre, au premier relevé où l'IA voit assez d'écart
 * après frais. « 15 s plus tard » exécute au prix du relevé suivant, pour
 * mesurer ce que coûte la lenteur. Quantité limitée à ce qui est en vente.
 */
export function simulate(
  test: IaSample[],
  preds: number[],
  minEdge: number,
  stake: number,
  slow: boolean,
): Trading {
  const taken = new Set<number>();
  const pnls: number[] = [];
  let wins = 0;
  for (let i = 0; i < test.length; i++) {
    const s = test[i];
    if (taken.has(s.window) || s.upAsk == null || s.downAsk == null) continue;
    const p = preds[i];
    const evUp = sideEv(p, s.upAsk, s.feeRate);
    const evDown = sideEv(1 - p, s.downAsk, s.feeRate);
    const buyUp = evUp >= evDown;
    if ((buyUp ? evUp : evDown) < minEdge) continue;
    taken.add(s.window);
    const fill = slow ? test[i + 1] : s;
    if (!fill || fill.window !== s.window || fill.elapsed - s.elapsed > 20) continue;
    const ask = buyUp ? fill.upAsk : fill.downAsk;
    const size = buyUp ? fill.upSize : fill.downSize;
    if (ask == null || !(ask > 0) || ask >= 1) continue;
    const shares = Math.min(stake / ask, size ?? Number.POSITIVE_INFINITY);
    if (shares < 5) continue;
    const won = buyUp ? s.y === 1 : s.y === 0;
    if (won) wins += 1;
    pnls.push(tradePnl(ask, won, shares * ask, fill.feeRate));
  }
  const st = meanSe(pnls);
  return {
    ecart: minEdge,
    execution: slow ? "15 s plus tard" : "immédiate",
    trades: pnls.length,
    gagnes: wins,
    total: pnls.reduce((a, b) => a + b, 0),
    moyenne: pnls.length ? st.mean : 0,
    incertitude: Number.isFinite(st.se) ? 2 * st.se : null,
  };
}

export type IaOptions = {
  stake?: number;
  folds?: number;
  trees?: Partial<TreeParams>;
  net?: Partial<NetParams>;
};

/**
 * Validation « en avançant dans le temps » : on entraîne sur tout le passé,
 * on teste sur le bloc suivant, puis on avance. Le premier tiers ne sert
 * qu'à apprendre.
 */
export function evaluate(samples: IaSample[], opts: IaOptions = {}) {
  const stake = opts.stake ?? 5;
  const folds = opts.folds ?? 4;
  const windows = [...new Set(samples.map((s) => s.window))].sort((a, b) => a - b);
  const first = Math.floor(windows.length * 0.4);
  const block = Math.ceil((windows.length - first) / folds);
  const test: IaSample[] = [];
  const preds = { arbres: [] as number[], reseau: [] as number[] };
  const steps = { arbres: [] as number[], reseau: [] as number[] };
  const importance = new Array<number>(IA_FEATURES.length).fill(0);
  for (let f = 0; f < folds; f++) {
    const from = windows[first + f * block];
    if (from === undefined) break;
    const to = windows[first + (f + 1) * block] ?? Number.POSITIVE_INFINITY;
    const train = samples.filter((s) => s.window < from);
    const now = samples.filter((s) => s.window >= from && s.window < to);
    if (train.length === 0 || now.length === 0) continue;
    const trees = trainTrees(train, opts.trees);
    const net = trainNet(train, opts.net);
    steps.arbres.push(trees.steps);
    steps.reseau.push(net.steps);
    trees.importance.forEach((v, j) => (importance[j] += v / folds));
    for (const s of now) {
      test.push(s);
      preds.arbres.push(trees.predict(s));
      preds.reseau.push(net.predict(s));
    }
  }
  const market = perWindow(test, (s) => logLoss(s.q, s.y));
  const avg = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0) / Math.max(m.size, 1);
  const report = (cle: "arbres" | "reseau", nom: string): ModelReport => {
    const p = preds[cle];
    const loss = perWindow(test, (s, i) => logLoss(p[i], s.y));
    const ecart = compare(loss, market);
    const trading = [
      ...EDGES.map((e) => simulate(test, p, e, stake, false)),
      ...EDGES.map((e) => simulate(test, p, e, stake, true)),
    ];
    const fast = trading.find((t) => t.ecart === VERDICT_EDGE && t.execution === "immédiate") as Trading;
    const slow = trading.find((t) => t.ecart === VERDICT_EDGE && t.execution !== "immédiate") as Trading;
    const bat =
      ecart.verdict === "MEILLEUR" &&
      fast.trades >= 100 &&
      fast.incertitude != null &&
      fast.moyenne - fast.incertitude > 0 &&
      slow.moyenne > 0;
    return {
      cle,
      nom,
      perteModele: avg(loss),
      perteMarche: avg(market),
      ecart,
      trading,
      etapes: steps[cle],
      importance:
        cle === "arbres"
          ? IA_FEATURES.map((signal, j) => ({ signal, part: importance[j] })).sort((a, b) => b.part - a.part)
          : null,
      bat,
    };
  };
  return {
    fenetresTest: market.size,
    modeles: [report("arbres", "Arbres de décision combinés"), report("reseau", "Réseau de neurones")],
  };
}

export const OBJECTIF = 5000;

export function verdictOf(windows: number, modeles: ModelReport[]): { verdict: string; explication: string } {
  const winner = modeles.find((m) => m.bat);
  const worse = modeles.every((m) => m.ecart.verdict === "moins bon");
  if (winner && windows >= OBJECTIF) {
    return {
      verdict: "BAT LE MARCHÉ",
      explication: `${winner.nom} prédit mieux que le marché et gagne après frais sur des fenêtres jamais vues. Prochaine étape : la brancher en papier, en direct, avant tout argent réel.`,
    };
  }
  if (winner) {
    return {
      verdict: "prometteur, à confirmer",
      explication: `${winner.nom} fait mieux que le marché, mais sur ${windows} fenêtres seulement : il en faut ${OBJECTIF} pour conclure.`,
    };
  }
  if (worse) {
    return {
      verdict: "moins bon que le marché",
      explication: "Sur des fenêtres jamais vues, l'IA se trompe davantage que le simple prix du marché.",
    };
  }
  return {
    verdict: "ne bat pas le marché",
    explication:
      windows >= OBJECTIF
        ? "Même avec beaucoup de données, l'IA n'apprend rien que le prix du marché ne sache déjà."
        : `Pour l'instant, l'IA n'apprend rien que le prix du marché ne sache déjà. Verdict définitif à ${OBJECTIF} fenêtres.`,
  };
}
