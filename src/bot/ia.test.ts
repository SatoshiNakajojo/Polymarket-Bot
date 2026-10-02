import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, rng, trainNet, trainTrees, verdictOf, type IaSample } from "./ia.ts";
import { logit, sigmoid } from "./journal-learn.ts";

/** Fenêtres de 19 relevés. `signal` : poids d'un vrai signal caché dans le 3e signal. */
function synthetic(windows: number, signal: number, seed: number): IaSample[] {
  const rand = rng(seed);
  const out: IaSample[] = [];
  for (let w = 0; w < windows; w++) {
    const hidden = rand() * 4 - 2;
    // Marché juste : il connaît la vraie probabilité, sauf la partie cachée.
    const q = signal === 0 ? 0.15 + rand() * 0.7 : 0.5;
    const truth = signal === 0 ? q : sigmoid(signal * hidden);
    const y = rand() < truth ? 1 : 0;
    for (let r = 0; r < 19; r++) {
      const x = Array.from({ length: 12 }, () => rand() * 2 - 1);
      x[0] = logit(q);
      x[2] = hidden;
      const ask = Math.min(0.99, q + 0.01);
      out.push({
        window: w * 300,
        elapsed: r * 15,
        x,
        y,
        q,
        upAsk: ask,
        downAsk: Math.min(0.99, 1 - q + 0.01),
        upSize: 500,
        downSize: 500,
        feeRate: 0.07,
      });
    }
  }
  return out;
}

const fast = { trees: { rounds: 120, patience: 20 }, net: { epochs: 15, patience: 4 } };

test("les arbres et le réseau trouvent un vrai signal", () => {
  const data = synthetic(1500, 1.5, 3);
  const trees = trainTrees(data, fast.trees);
  const net = trainNet(data, fast.net);
  const up = { ...data[0], x: [...data[0].x], q: 0.5 };
  up.x[2] = 1.5;
  const down = { ...up, x: [...up.x] };
  down.x[2] = -1.5;
  assert.ok(trees.predict(up) > 0.75 && trees.predict(down) < 0.25, "arbres");
  assert.ok(net.predict(up) > 0.75 && net.predict(down) < 0.25, "réseau");
  assert.ok(trees.steps > 0 && net.steps > 0);
});

test("avec un signal réel, le verdict le voit", () => {
  const { modeles } = evaluate(synthetic(1500, 1.5, 4), fast);
  for (const m of modeles) {
    assert.equal(m.ecart.verdict, "MEILLEUR", m.nom);
    assert.ok(m.bat, m.nom);
  }
  assert.equal(modeles[0].importance?.[0].signal, "élan BTC 15 s");
  assert.equal(verdictOf(1500, modeles).verdict, "prometteur, à confirmer");
  assert.equal(verdictOf(6000, modeles).verdict, "BAT LE MARCHÉ");
});

test("sur un marché juste, l'IA n'invente rien", () => {
  for (const seed of [11, 12, 13]) {
    const { modeles } = evaluate(synthetic(1200, 0, seed), fast);
    for (const m of modeles) {
      assert.notEqual(m.ecart.verdict, "MEILLEUR", `${m.nom}, graine ${seed}`);
      assert.equal(m.bat, false, `${m.nom}, graine ${seed}`);
      // Elle reste collée au marché : écart de perte minuscule.
      assert.ok(Math.abs(m.perteModele - m.perteMarche) < 0.01, `${m.nom} s'éloigne du marché`);
    }
    assert.notEqual(verdictOf(1200, modeles).verdict, "BAT LE MARCHÉ");
  }
});
