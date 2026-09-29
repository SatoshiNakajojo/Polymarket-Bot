import assert from "node:assert/strict";
import test from "node:test";
import { vetOrder } from "./policy.ts";

const limits = { maxStake: 10, lossCap: 80 };
const fresh = { spent: 0, lastWindow: null };

test("accepte un achat BTC 5 min dans le plafond", () => {
  const result = vetOrder(
    {
      assetId: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
      amount: 10,
      maxPrice: 0.62,
      windowStart: 1_700_000_100,
      slug: "btc-updown-5m-1700000100",
    },
    limits,
    fresh,
  );
  assert.equal(result.ok, true);
});

test("refuse un autre marché, une mise trop grosse, et une fenêtre déjà prise", () => {
  assert.equal(
    vetOrder({ assetId: "1".repeat(20), amount: 5, maxPrice: 0.5, windowStart: 1, slug: "eth-updown-5m-1" }, limits, fresh).ok,
    false,
  );
  assert.equal(
    vetOrder(
      { assetId: "1".repeat(20), amount: 50, maxPrice: 0.5, windowStart: 1, slug: "btc-updown-5m-1" },
      limits,
      fresh,
    ).ok,
    false,
  );
  const taken = vetOrder(
    { assetId: "1".repeat(20), amount: 5, maxPrice: 0.5, windowStart: 9, slug: "btc-updown-5m-9" },
    limits,
    { spent: 0, lastWindow: 9 },
  );
  assert.equal(taken.ok, false);
  if (!taken.ok) assert.match(taken.message, /fenêtre/);
});

test("accepte une seule couverture sur la fenêtre déjà prise", () => {
  const order = {
    assetId: "1".repeat(20),
    amount: 15,
    maxPrice: 0.4,
    windowStart: 9,
    slug: "btc-updown-5m-9",
    hedge: true,
  };
  const first = vetOrder(order, limits, { spent: 5, lastWindow: 9, hedgedWindow: null });
  assert.equal(first.ok, true);
  const second = vetOrder(order, limits, { spent: 20, lastWindow: 9, hedgedWindow: 9 });
  assert.equal(second.ok, false);
});
