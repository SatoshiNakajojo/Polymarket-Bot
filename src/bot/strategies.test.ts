import assert from "node:assert/strict";
import test from "node:test";
import type { Row } from "./journal-data.ts";
import { groupWindows, runStops, type WindowRows } from "./strategies.ts";

const fee = (p: number) => 0.07 * p * (1 - p);

function row(elapsed: number, spot: number, upBid: number, upAsk: number, up: 0 | 1): Row {
  return {
    window: 1_000,
    elapsed,
    remaining: 300 - elapsed,
    spot,
    strike: 100,
    sigma: 5,
    pModel: 0.5,
    upBid,
    upAsk,
    upSize: 100,
    downBid: Math.round((1 - upAsk) * 100) / 100,
    downAsk: Math.round((1 - upBid) * 100) / 100,
    feeRate: 0.07,
    upBidSize: 100,
    upBidDepth: 100,
    upAskDepth: 100,
    ret15: 0,
    ret60: 0,
    ret300: 0,
    up,
  };
}

function win(rows: Row[], up: 0 | 1): WindowRows {
  return { window: 1_000, rows, up, previousUp: null };
}

test("un achat gardé jusqu'au règlement paie parts − mise − frais", () => {
  const w = win([row(60, 110, 0.59, 0.6, 1), row(75, 111, 0.62, 0.63, 1)], 1);
  const r = runStops(w, "instant", { i: 0, side: "Up" }, 0, 1, "strike") as { pnl: number };
  const shares = 5 / 0.6;
  assert.ok(Math.abs(r.pnl - (shares - 5 - shares * fee(0.6))) < 1e-9);
});

test("un stop vend au prix acheteur, frais compris, et ne tient plus rien", () => {
  const w = win([row(60, 110, 0.59, 0.6, 1), row(75, 95, 0.4, 0.41, 1), row(90, 120, 0.9, 0.91, 1)], 1);
  const r = runStops(w, "instant", { i: 0, side: "Up" }, 0, 1, "strike") as { pnl: number; legs: number };
  const shares = 5 / 0.6;
  const expected = -5 - shares * fee(0.6) + shares * 0.4 - shares * fee(0.4);
  assert.ok(Math.abs(r.pnl - expected) < 1e-9);
  assert.equal(r.legs, 2);
});

test("la martingale double la mise à chaque retournement, jusqu'au plafond", () => {
  const rows = [
    row(60, 110, 0.59, 0.6, 0),
    row(75, 95, 0.4, 0.41, 0),
    row(90, 105, 0.55, 0.56, 0),
    row(105, 96, 0.44, 0.45, 0),
    row(120, 104, 0.53, 0.54, 0),
  ];
  const r = runStops(win(rows, 0), "instant", { i: 0, side: "Up" }, 2, 3, "strike") as { volume: number; legs: number };
  // 1 achat + 3 × (vente + achat) : mises 5, 10, 20, 40
  assert.equal(r.legs, 7);
  assert.ok(r.volume > 5 + 10 + 20 + 40);
});

test("en mode lent, l'ordre s'exécute au relevé suivant", () => {
  const w = win([row(60, 110, 0.59, 0.6, 1), row(75, 111, 0.69, 0.7, 1)], 1);
  const r = runStops(w, "lent", { i: 0, side: "Up" }, 0, 1, "strike") as { pnl: number };
  const shares = 5 / 0.7;
  assert.ok(Math.abs(r.pnl - (shares - 5 - shares * fee(0.7))) < 1e-9);
});

test("groupWindows relie chaque fenêtre au résultat de la précédente", () => {
  const a = { ...row(60, 110, 0.5, 0.51, 1), window: 1_000 };
  const b = { ...row(60, 110, 0.5, 0.51, 0), window: 1_300 };
  const [w1, w2] = groupWindows([b, a]);
  assert.equal(w1.previousUp, null);
  assert.equal(w2.previousUp, 1);
});
