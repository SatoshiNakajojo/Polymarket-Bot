import assert from "node:assert/strict";
import test from "node:test";
import type { Row } from "./journal-data.ts";
import { featureVector, fitLogistic, predict, sigmoid } from "./journal-learn.ts";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

test("fitLogistic retrouve des coefficients connus", () => {
  const rand = rng(7);
  const truth = [0.3, 1.2, -0.8];
  const x: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 20_000; i++) {
    const xi = [1, rand() * 4 - 2, rand() * 4 - 2];
    x.push(xi);
    y.push(rand() < predict(truth, xi) ? 1 : 0);
  }
  const fit = fitLogistic(x, y, 0.01);
  fit.beta.forEach((b, j) => assert.ok(Math.abs(b - truth[j]) < 4 * fit.se[j] + 0.02, `coef ${j}: ${b} vs ${truth[j]}`));
  assert.ok(fit.se.every((s) => s > 0 && s < 0.1));
});

test("sigmoid est bornée", () => {
  assert.equal(sigmoid(0), 0.5);
  assert.ok(sigmoid(50) <= 1 && sigmoid(-50) >= 0);
});

const base: Row = {
  window: 1,
  elapsed: 60,
  remaining: 240,
  spot: 100_000,
  strike: 99_990,
  sigma: 5,
  pModel: 0.6,
  upBid: 0.54,
  upAsk: 0.56,
  upSize: 100,
  downBid: 0.44,
  downAsk: 0.46,
  downSize: 100,
  feeRate: 0.07,
  upBidSize: 300,
  upBidDepth: 900,
  upAskDepth: 300,
  ret15: 0.0002,
  ret60: -0.0001,
  ret300: 0,
  up: 1,
};

test("featureVector : signes des signaux", () => {
  const x = featureVector(base, { ...base, elapsed: 45, upBid: 0.49, upAsk: 0.51 }) as number[];
  assert.equal(x.length, 9);
  assert.ok(x[1] > 0, "marché au-dessus de 50 %");
  assert.ok(x[2] > 0, "modèle plus haut que le marché");
  assert.ok(x[3] > 0 && x[4] < 0, "élan 15 s positif, 1 min négatif");
  assert.ok(x[6] > 0 && x[7] > 0, "plus d'acheteurs que de vendeurs");
  assert.ok(x[8] > 0, "le prix du marché a monté en 15 s");
});

test("featureVector refuse une observation incomplète", () => {
  assert.equal(featureVector({ ...base, ret15: null }, null), null);
  assert.equal(featureVector({ ...base, upBid: null }, null), null);
  assert.equal(featureVector({ ...base, upBid: 0.3, upAsk: 0.6 }, null), null);
  const x = featureVector(base, { ...base, window: 2 }) as number[];
  assert.equal(x[8], 0, "pas de variation entre deux fenêtres");
});
