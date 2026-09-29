import assert from "node:assert/strict";
import test from "node:test";
import { MakerSim } from "./maker.ts";

/** Carnet miroir : Down = 1 − Up. */
function market(sim: MakerSim, upBid: number, upAsk: number, sizeUp = 100, sizeDown = 100, t = 0) {
  const r = (x: number) => Math.round(x * 100) / 100;
  sim.onBook("Up", [{ price: upBid, size: sizeUp }], [{ price: upAsk, size: sizeDown }], t);
  sim.onBook("Down", [{ price: r(1 - upAsk), size: sizeDown }], [{ price: r(1 - upBid), size: sizeUp }], t);
}

test("on cote les deux côtés au meilleur prix acheteur, derrière la file", () => {
  const sim = new MakerSim();
  market(sim, 0.55, 0.56, 80, 40);
  sim.requote(0, 200);
  assert.equal(sim.orders.Up?.price, 0.55);
  assert.equal(sim.orders.Up?.ahead, 80);
  assert.equal(sim.orders.Down?.price, 0.44);
  assert.equal(sim.orders.Down?.ahead, 40);
});

test("une vente à notre prix consomme d'abord la file, puis nous remplit", () => {
  const sim = new MakerSim();
  market(sim, 0.55, 0.56, 80, 40);
  sim.requote(0, 200);
  sim.onTrade("Up", 0.55, 50, "SELL", 1);
  assert.equal(sim.shares.Up, 0);
  assert.equal(sim.orders.Up?.ahead, 30);
  sim.onTrade("Up", 0.55, 35, "SELL", 2);
  assert.equal(sim.shares.Up, 5);
  assert.equal(sim.fills.at(-1)?.how, "file");
  sim.onTrade("Up", 0.55, 100, "BUY", 3);
  assert.equal(sim.shares.Up, 5, "un achat preneur ne touche pas les acheteurs");
});

test("une vente plus bas ou un prix vendeur qui descend nous remplit en entier", () => {
  const sim = new MakerSim();
  market(sim, 0.55, 0.56);
  sim.requote(0, 200);
  sim.onTrade("Up", 0.54, 1, "SELL", 1);
  assert.equal(sim.shares.Up, 10);
  assert.equal(sim.orders.Up, null);
  sim.onLevel("Down", "ask", 0.44, 20, 2);
  assert.equal(sim.shares.Down, 10);
  assert.equal(sim.fills.at(-1)?.how, "croisement");
});

test("une annulation ne nous fait avancer que si le niveau rétrécit sous notre file", () => {
  const sim = new MakerSim();
  market(sim, 0.55, 0.56, 80);
  sim.requote(0, 200);
  sim.onLevel("Up", "bid", 0.55, 90, 1);
  assert.equal(sim.orders.Up?.ahead, 80);
  sim.onLevel("Up", "bid", 0.55, 25, 2);
  assert.equal(sim.orders.Up?.ahead, 25);
});

test("au plafond de déséquilibre, on ne cote plus que le côté en retard, sous 1 $ la paire", () => {
  const sim = new MakerSim({ quoteSize: 20, maxImbalance: 20 });
  market(sim, 0.6, 0.61);
  sim.requote(0, 200);
  sim.onTrade("Up", 0.59, 1, "SELL", 1);
  assert.equal(sim.shares.Up, 20);
  sim.orders.Down = null; // sinon la hausse de Up l'exécuterait au passage (et compléterait la paire)
  const down = () => sim.orders.Down;
  market(sim, 0.7, 0.71, 100, 100, 2);
  sim.requote(2, 150);
  assert.equal(sim.orders.Up, null, "côté lourd : plus d'ordre");
  assert.equal(down()?.price, 0.29);
  market(sim, 0.5, 0.51, 100, 100, 3);
  sim.requote(3, 140);
  assert.equal(down()?.price, 0.39, "plafonné à 1 − 0,60 − 1 c");
});

test("plus d'ordres dans les dernières secondes ni sur un carnet extrême", () => {
  const sim = new MakerSim();
  market(sim, 0.55, 0.56);
  sim.requote(0, 30);
  assert.equal(sim.orders.Up, null);
  market(sim, 0.97, 0.98);
  sim.requote(1, 200);
  assert.equal(sim.orders.Up, null);
});

test("règlement : une paire complète rapporte 1 $ moins son coût", () => {
  const sim = new MakerSim();
  market(sim, 0.55, 0.56);
  sim.requote(0, 200);
  sim.onTrade("Up", 0.54, 1, "SELL", 1);
  sim.onTrade("Down", 0.43, 1, "SELL", 2);
  const r = sim.settle("Down");
  assert.equal(r.pairs, 10);
  assert.ok(Math.abs(r.pnl - (10 - 10 * 0.55 - 10 * 0.44)) < 1e-9);
  assert.ok(Math.abs(r.pairPnl - 0.1) < 1e-9);
});

test("quand le prix monte, notre ordre sur l'autre côté est exécuté au passage et complète la paire", () => {
  const sim = new MakerSim({ quoteSize: 20, maxImbalance: 20 });
  market(sim, 0.6, 0.61);
  sim.requote(0, 200);
  sim.onTrade("Up", 0.59, 1, "SELL", 1);
  market(sim, 0.7, 0.71, 100, 100, 2);
  assert.equal(sim.shares.Down, 20);
  assert.ok(Math.abs(sim.settle("Up").pairPnl - 0.2) < 1e-9);
});

test("anti-choc : un saut du carnet retire les ordres pendant la pause", () => {
  const sim = new MakerSim({ pauseJump: 0.03, pauseSec: 10 });
  const up = () => sim.orders.Up;
  market(sim, 0.5, 0.51, 100, 100, 0);
  sim.requote(0, 200);
  assert.equal(up()?.price, 0.5);
  market(sim, 0.54, 0.55, 100, 100, 2);
  assert.equal(up(), null);
  sim.requote(3, 200);
  assert.equal(up(), null, "toujours en pause");
  sim.requote(13, 190);
  assert.equal(up()?.price, 0.54, "reprise après la pause");
});
