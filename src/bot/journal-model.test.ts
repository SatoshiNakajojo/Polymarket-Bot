import assert from "node:assert/strict";
import test from "node:test";
import { fairUpTwap60, sigmaFromCloses, stepAverage, tradePnl, valueAt } from "./journal-model.ts";

test("stepAverage pondère par la durée", () => {
  const ticks = [
    { t: 0, v: 100 },
    { t: 30, v: 200 },
  ];
  assert.equal(stepAverage(ticks, 0, 60), 150);
  assert.equal(stepAverage(ticks, 30, 60), 200);
  assert.equal(stepAverage([{ t: 50, v: 1 }], 0, 60), null);
});

test("valueAt refuse une valeur trop vieille", () => {
  const ticks = [{ t: 10, v: 5 }];
  assert.equal(valueAt(ticks, 15, 10), 5);
  assert.equal(valueAt(ticks, 25, 10), null);
  assert.equal(valueAt(ticks, 5, 10), null);
});

test("50 % quand le prix est au strike, continu à 60 s", () => {
  const at = (r: number) => fairUpTwap60({ strike: 100_000, spot: 100_000, lockedAvg: 100_000, remainingSec: r, sigma: 5 });
  assert.ok(Math.abs(at(200).p - 0.5) < 1e-6);
  const above = (r: number) =>
    fairUpTwap60({ strike: 100_000, spot: 100_030, lockedAvg: 100_030, remainingSec: r, sigma: 5 });
  assert.ok(Math.abs(above(60).std - above(59.999).std) < 0.01);
  assert.ok(above(10).p > above(120).p);
});

test("le modèle colle à une simulation Monte Carlo du règlement TWAP 60 s", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const sigma = 5;
  for (const [remaining, spot, lockedAvg] of [
    [150, 100_020, null],
    [40, 100_010, 100_025],
  ] as const) {
    const strike = 100_000;
    const paths = 20_000;
    let ups = 0;
    for (let i = 0; i < paths; i++) {
      let s = spot;
      let acc = lockedAvg == null ? 0 : lockedAvg * (60 - remaining);
      for (let k = remaining - 1; k >= 0; k--) {
        s += sigma * gauss();
        if (k < 60) acc += s;
      }
      if (acc / 60 >= strike) ups += 1;
    }
    const model = fairUpTwap60({ strike, spot, lockedAvg, remainingSec: remaining, sigma }).p;
    assert.ok(Math.abs(model - ups / paths) < 0.02, `R=${remaining} modèle ${model} simulé ${ups / paths}`);
  }
});

test("sigmaFromCloses donne des $/√s", () => {
  const closes = Array.from({ length: 61 }, (_, i) => 100_000 * (1 + (i % 2 ? 0.0005 : -0.0005)));
  const sigma = sigmaFromCloses(closes) as number;
  assert.ok(sigma > 5 && sigma < 20);
});

test("tradePnl compte les frais", () => {
  assert.ok(Math.abs(tradePnl(0.5, true, 5, 0.07) - (10 - 5 - 10 * 0.07 * 0.25)) < 1e-9);
  assert.ok(Math.abs(tradePnl(0.5, false, 5, 0.07) - (-5 - 10 * 0.07 * 0.25)) < 1e-9);
});
