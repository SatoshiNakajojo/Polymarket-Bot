import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ENTRY_MIN_REMAINING,
  MAX_SPREAD,
  decide,
  fairUp,
  maxAskForEdge,
  pairLock,
  PAIR_MIN,
  settlementPnl,
  takerFeePerShare,
  type Side,
} from "@/lib/engine.ts";
import { connectLive, placeLiveOrder, placeLiveSell } from "@/lib/live.ts";
import { loadSnapshot } from "@/lib/market-data.server.ts";
import { builderFromEnv, hasKey, readKey } from "./key.ts";
import { vetOrder } from "./policy.ts";

type Fill = {
  window: number;
  side: Side;
  stake: number;
  ask: number;
  btc?: number;
  result?: "win" | "loss" | "stop";
  exitPrice?: number;
};
type Disk = { spent: number; windows: number[]; fills: Fill[] };
type PlaceResult = { ok: boolean; message?: string; orderId?: string; filledUsd?: number };

const stateFile = process.env.FENETRE_STATE ?? "data/fenetre-bot.json";
const stake = Number(process.env.FENETRE_STAKE ?? 10);
const minEdge = Number(process.env.FENETRE_EDGE ?? 0.03);
const lossCap = Number(process.env.FENETRE_CAP ?? 80);
const waitMin = Number(process.env.FENETRE_WAIT ?? 3);
const earlyPrice = Number(process.env.FENETRE_EARLY ?? 75) / 100;
const invert = process.env.FENETRE_INVERT === "1";
const pair = process.env.FENETRE_PAIR === "1";
const btcStop = process.env.FENETRE_BTC_STOP !== "0";
const armed = process.env.FENETRE_ARMED !== "0";
const local = hasKey();
const remote = Boolean(process.env.SIGNER_URL);
if (!local && !remote) {
  throw new Error("Aucune clé ici, et SIGNER_URL manque. Le VPS ne signe pas.");
}
if (!local && (process.env.SIGNER_TOKEN ?? "").length < 16) {
  throw new Error("SIGNER_URL est défini mais SIGNER_TOKEN est trop court.");
}

function loadDisk(): Disk {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as Disk;
    return {
      spent: Number(parsed.spent) || 0,
      windows: Array.isArray(parsed.windows) ? parsed.windows.filter((n) => Number.isFinite(n)) : [],
      fills: Array.isArray(parsed.fills) ? parsed.fills : [],
    };
  } catch {
    return { spent: 0, windows: [], fills: [] };
  }
}

function saveDisk(disk: Disk) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(disk));
}

async function placeRemote(path: "/order" | "/sell", body: unknown): Promise<PlaceResult> {
  const token = process.env.SIGNER_TOKEN ?? "";
  const signerUrl = (process.env.SIGNER_URL ?? "").replace(/\/$/, "");
  const response = await fetch(`${signerUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = (await response.json()) as PlaceResult;
  if (response.status === 401 || response.status >= 500) {
    throw new Error(parsed.message ?? `Signer injoignable (${response.status}).`);
  }
  return parsed;
}

async function sendBuy(order: {
  assetId: string;
  amount: number;
  maxPrice: number;
  windowStart: number;
  slug: string;
  hedge?: boolean;
}): Promise<PlaceResult> {
  if (!local) return placeRemote("/order", order);
  const placed = await placeLiveOrder({ tokenId: order.assetId, amount: order.amount, maxPrice: order.maxPrice });
  return placed.ok
    ? { ok: true, orderId: placed.orderId, filledUsd: placed.filledUsd }
    : { ok: false, message: placed.message };
}

async function sendSell(order: {
  assetId: string;
  shares: number;
  minPrice: number;
  windowStart: number;
  slug: string;
}): Promise<PlaceResult> {
  if (!local) return placeRemote("/sell", order);
  const placed = await placeLiveSell({ tokenId: order.assetId, shares: order.shares, minPrice: order.minPrice });
  return placed.ok ? { ok: true, orderId: placed.orderId } : { ok: false, message: placed.message };
}

function fillPnl(fill: Fill): number {
  if (fill.result === "stop") {
    const exit = fill.exitPrice ?? 0;
    const shares = fill.ask > 0 ? fill.stake / fill.ask : 0;
    return shares * exit - fill.stake - shares * (takerFeePerShare(fill.ask) + takerFeePerShare(exit));
  }
  if (!fill.result) return 0;
  return settlementPnl(fill.stake, fill.ask, fill.result === "win");
}

function drawdown(disk: Disk): number {
  let pnl = 0;
  let pending = 0;
  for (const fill of disk.fills) {
    if (!fill.result) pending += fill.stake;
    else pnl += fillPnl(fill);
  }
  if (disk.fills.length === 0) return disk.spent;
  return pending + Math.max(0, -pnl);
}

async function tick(disk: Disk) {
  const snap = await loadSnapshot();
  if (!snap.ok) {
    console.log(snap.error);
    return;
  }
  const now = snap.serverNow;
  let settledChanged = false;
  for (const fill of disk.fills) {
    if (fill.result) continue;
    const row = snap.settled.find((item) => item.start === fill.window);
    if (!row) continue;
    fill.result = row.outcome === fill.side ? "win" : "loss";
    settledChanged = true;
  }
  if (settledChanged) saveDisk(disk);
  const market = snap.market;
  const open = disk.fills.filter((fill) => fill.window === snap.live.start && !fill.result);
  if (
    pair &&
    market &&
    open.length === 0 &&
    !disk.windows.includes(snap.live.start) &&
    market.up.ask != null &&
    market.down.ask != null &&
    pairLock(market.up.ask, market.down.ask, snap.feeRate) >= PAIR_MIN
  ) {
    const upAsk = market.up.ask;
    const downAsk = market.down.ask;
    const shares = Math.floor((stake / (upAsk + downAsk)) * 100) / 100;
    const upUsd = Math.floor(shares * upAsk * 100) / 100;
    const downUsd = Math.floor(shares * downAsk * 100) / 100;
    if (shares >= snap.minOrderSize && upUsd >= 1 && downUsd >= 1) {
      const up = await sendBuy({
        assetId: market.upToken,
        amount: upUsd,
        maxPrice: Math.min(0.99, upAsk + 0.01),
        windowStart: snap.live.start,
        slug: market.slug,
        hedge: false,
      });
      if (up.ok) {
        disk.windows = [snap.live.start, ...disk.windows].slice(0, 40);
        disk.fills.push({ window: snap.live.start, side: "Up", stake: upUsd, ask: upAsk, btc: snap.price });
        const down = await sendBuy({
          assetId: market.downToken,
          amount: downUsd,
          maxPrice: Math.min(0.99, downAsk + 0.01),
          windowStart: snap.live.start,
          slug: market.slug,
          hedge: true,
        });
        if (down.ok) {
          disk.fills.push({ window: snap.live.start, side: "Down", stake: downUsd, ask: downAsk, btc: snap.price });
        }
        saveDisk(disk);
        console.log(down.ok ? `paire ${upUsd}$ + ${downUsd}$` : `paire incomplète: ${down.message ?? ""}`);
      } else {
        console.log(`paire refusée: ${up.message ?? ""}`);
      }
      return;
    }
  }
  const solo = open.length === 1 ? open[0] : null;
  if (solo && market) {
    const crossed =
      btcStop && solo.btc != null && (solo.side === "Up" ? snap.price < solo.btc : snap.price > solo.btc);
    if (crossed && !pair) {
      const bid = solo.side === "Up" ? market.up.bid : market.down.bid;
      const assetId = solo.side === "Up" ? market.upToken : market.downToken;
      if (bid != null) {
        const shares = Math.floor((solo.stake / solo.ask) * 100) / 100;
        const sold = await sendSell({
          assetId,
          shares,
          minPrice: Math.max(0.01, bid - 0.01),
          windowStart: snap.live.start,
          slug: market.slug,
        });
        if (sold.ok) {
          solo.result = "stop";
          solo.exitPrice = bid;
          saveDisk(disk);
        }
        console.log(sold.ok ? `stop BTC ${solo.side}` : `stop refusé: ${sold.message ?? ""}`);
        return;
      }
    } else if (pair) {
      const other: Side = solo.side === "Up" ? "Down" : "Up";
      const otherAsk = other === "Up" ? market.up.ask : market.down.ask;
      const otherToken = other === "Up" ? market.upToken : market.downToken;
      if (otherAsk != null && pairLock(solo.ask, otherAsk, snap.feeRate) >= PAIR_MIN) {
        const shares = Math.floor((solo.stake / solo.ask) * 100) / 100;
        const usd = Math.floor(shares * otherAsk * 100) / 100;
        if (shares >= snap.minOrderSize && usd >= 1) {
          const placed = await sendBuy({
            assetId: otherToken,
            amount: usd,
            maxPrice: Math.min(0.99, otherAsk + 0.01),
            windowStart: snap.live.start,
            slug: market.slug,
            hedge: true,
          });
          if (placed.ok) {
            disk.fills.push({ window: snap.live.start, side: other, stake: usd, ask: otherAsk, btc: snap.price });
            saveDisk(disk);
          }
          console.log(placed.ok ? `couverture ${other} ${usd}$` : `couverture refusée: ${placed.message ?? ""}`);
          return;
        }
      }
    }
  }
  const atRisk = drawdown(disk);
  const fair = fairUp({
    strike: snap.live.strike,
    twap: snap.live.twap,
    price: snap.price,
    elapsedSec: Math.max(0, now - snap.live.start),
    remainingSec: Math.max(0, snap.live.end - now),
    sigmaPerSqrtSec: snap.sigmaPerSqrtSec,
  });
  const decision = decide({
    remainingSec: Math.max(0, snap.live.end - now),
    pUp: fair.pUp,
    up: market?.up ?? { bid: null, ask: null, askSize: null },
    down: market?.down ?? { bid: null, ask: null, askSize: null },
    stakeUsd: stake,
    minOrderSize: snap.minOrderSize,
    feeRate: snap.feeRate,
    minEdge,
    minRemaining: ENTRY_MIN_REMAINING,
    maxRemaining: 300 - waitMin * 60,
    maxSpread: MAX_SPREAD,
    lossHalted: atRisk >= lossCap,
    alreadyIn: disk.windows.includes(snap.live.start),
    armed,
    marketState: !market ? "missing" : market.acceptingOrders ? "ready" : "closed",
    cash: Number.POSITIVE_INFINITY,
    invert,
    earlyPrice,
  });
  if (decision.action !== "buy" || !decision.side || decision.ask == null || !market) {
    console.log(decision.reason);
    return;
  }
  const assetId = decision.side === "Up" ? market.upToken : market.downToken;
  const pModel = decision.side === "Up" ? fair.pUp : 1 - fair.pUp;
  const edged = Math.floor((maxAskForEdge(pModel, minEdge, snap.feeRate) + 1e-9) * 100) / 100;
  const maxPrice = invert
    ? Math.min(0.8, Math.floor((decision.ask + 0.01 + 1e-9) * 100) / 100)
    : Math.min(0.8, edged);
  if (maxPrice + 1e-9 < decision.ask) {
    console.log("L'écart disparaît si on paie le prix disponible.");
    return;
  }
  const order = {
    assetId,
    amount: stake,
    maxPrice,
    windowStart: snap.live.start,
    slug: market.slug,
    hedge: false,
  };
  if (local) {
    const verdict = vetOrder(
      order,
      { maxStake: stake, lossCap },
      { spent: atRisk, lastWindow: disk.windows[0] ?? null },
    );
    if (!verdict.ok) {
      console.log(verdict.message);
      return;
    }
  }
  disk.windows = [snap.live.start, ...disk.windows].slice(0, 40);
  saveDisk(disk);
  const placed = await sendBuy(order);
  if (placed.ok) {
    disk.fills.push({ window: snap.live.start, side: decision.side, stake, ask: decision.ask, btc: snap.price });
    saveDisk(disk);
  }
  console.log(
    placed.ok
      ? `ordre ${placed.orderId} ${decision.side} ${stake}$`
      : `refusé: ${placed.message ?? "sans détail"}`,
  );
}

const disk = loadDisk();
if (local) {
  const session = await connectLive(readKey(), process.env.POLY_FUNDER ?? "", builderFromEnv());
  console.log(`Bot sur cette machine · ${session.wallet} · plafond ${lossCap}$.`);
} else {
  console.log(`Bot sans clé · signer ${process.env.SIGNER_URL} · plafond ${lossCap}$.`);
}
for (;;) {
  try {
    await tick(disk);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
