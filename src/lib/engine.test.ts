import assert from "node:assert/strict";
import test from "node:test";
import {
  bookProblem,
  decide,
  fairUp,
  maxAskForEdge,
  normalCdf,
  takerFeePerShare,
  windowStartSec,
} from "./engine.ts";

test("normal cdf is centered and monotonic", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-4);
  assert.ok(normalCdf(1.96) > 0.97);
  assert.ok(normalCdf(-1.96) < 0.03);
});

test("window start aligns to 5 minutes", () => {
  assert.equal(windowStartSec(1_790_427_269), 1_790_427_000);
  assert.equal(windowStartSec(1_790_427_000), 1_790_427_000);
});

test("limit price keeps the minimum edge after fees", () => {
  const ask = maxAskForEdge(0.7, 0.03, 0.07);
  const fee = 0.07 * ask * (1 - ask);
  assert.ok(Math.abs(0.7 - ask - fee - 0.03) < 1e-6);
});

test("taker fee peaks at 50c", () => {
  assert.ok(Math.abs(takerFeePerShare(0.5) - 0.0175) < 1e-9);
  assert.ok(takerFeePerShare(0.9) < takerFeePerShare(0.5));
});

test("fair probability rises when price holds above the TWAP breakeven", () => {
  const calm = fairUp({
    strike: 84_000,
    twap: 84_000,
    price: 84_000,
    elapsedSec: 200,
    remainingSec: 100,
    sigmaPerSqrtSec: 4,
  });
  const lifted = fairUp({
    strike: 84_000,
    twap: 84_010,
    price: 84_080,
    elapsedSec: 200,
    remainingSec: 60,
    sigmaPerSqrtSec: 4,
  });
  assert.ok(Math.abs(calm.pUp - 0.5) < 0.08);
  assert.ok(lifted.pUp > 0.9);
});

test("bot buys the cheap side of a clear edge and waits when early", () => {
  const base = {
    pUp: 0.8,
    up: { bid: 0.6, ask: 0.62, askSize: 100 },
    down: { bid: 0.38, ask: 0.4, askSize: 80 },
    stakeUsd: 10,
    minOrderSize: 5,
    feeRate: 0.07,
    minEdge: 0.03,
    minRemaining: 20,
    maxRemaining: 110,
    maxSpread: 0.08,
    lossHalted: false,
    alreadyIn: false,
    armed: true,
    marketState: "ready" as const,
    cash: 1000,
  };
  const buy = decide({ ...base, remainingSec: 40 });
  assert.equal(buy.action, "buy");
  assert.equal(buy.side, "Up");
  assert.ok((buy.shares ?? 0) >= 5);
  assert.equal(decide({ ...base, remainingSec: 200 }).action, "wait");
  assert.equal(decide({ ...base, remainingSec: 40, armed: false }).action, "wait");
});

test("broken complement book is refused", () => {
  const reason = bookProblem(
    { bid: 0.2, ask: 0.22, askSize: 10 },
    { bid: 0.2, ask: 0.22, askSize: 10 },
    0.08,
  );
  assert.ok(reason);
});
