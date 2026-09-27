import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ENTRY_MAX_REMAINING,
  ENTRY_MIN_REMAINING,
  MAX_SPREAD,
  decide,
  fairUp,
} from "@/lib/engine.ts";
import { connectLive, placeLiveOrder } from "@/lib/live.ts";
import { loadSnapshot } from "@/lib/market-data.server.ts";
import { hasKey, readKey } from "./key.ts";
import { vetOrder } from "./policy.ts";

type Disk = { spent: number; windows: number[] };
type PlaceResult = { ok: boolean; message?: string; orderId?: string };

const stateFile = process.env.FENETRE_STATE ?? "data/fenetre-bot.json";
const stake = Number(process.env.FENETRE_STAKE ?? 10);
const minEdge = Number(process.env.FENETRE_EDGE ?? 0.03);
const lossCap = Number(process.env.FENETRE_CAP ?? 80);
const armed = process.env.FENETRE_ARMED !== "0";
const local = hasKey();
const remote = Boolean(process.env.SIGNER_URL);
if (!local && !remote) {
  throw new Error("POLY_KEY_FILE manquant. Le bot signe sur cette machine, rien ne part sur un VPS.");
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
    };
  } catch {
    return { spent: 0, windows: [] };
  }
}

function saveDisk(disk: Disk) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(disk));
}

async function placeRemote(body: unknown): Promise<PlaceResult> {
  const token = process.env.SIGNER_TOKEN ?? "";
  const signerUrl = (process.env.SIGNER_URL ?? "").replace(/\/$/, "");
  const response = await fetch(`${signerUrl}/order`, {
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

async function tick(disk: Disk) {
  const snap = await loadSnapshot();
  if (!snap.ok) {
    console.log(snap.error);
    return;
  }
  const now = snap.serverNow;
  const fair = fairUp({
    strike: snap.live.strike,
    twap: snap.live.twap,
    price: snap.price,
    elapsedSec: Math.max(0, now - snap.live.start),
    remainingSec: Math.max(0, snap.live.end - now),
    sigmaPerSqrtSec: snap.sigmaPerSqrtSec,
  });
  const market = snap.market;
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
    maxRemaining: ENTRY_MAX_REMAINING,
    maxSpread: MAX_SPREAD,
    lossHalted: disk.spent >= lossCap,
    alreadyIn: disk.windows.includes(snap.live.start),
    armed,
    marketState: !market ? "missing" : market.acceptingOrders ? "ready" : "closed",
    cash: Number.POSITIVE_INFINITY,
  });
  if (decision.action !== "buy" || !decision.side || decision.ask == null || !market) {
    console.log(decision.reason);
    return;
  }
  const assetId = decision.side === "Up" ? market.upToken : market.downToken;
  const maxPrice = Math.min(0.99, Math.ceil(decision.ask * 100 - 1e-9) / 100);
  const order = {
    assetId,
    amount: stake,
    maxPrice,
    windowStart: snap.live.start,
    slug: market.slug,
  };
  if (local) {
    const verdict = vetOrder(
      order,
      { maxStake: stake, lossCap },
      { spent: disk.spent, lastWindow: disk.windows[0] ?? null },
    );
    if (!verdict.ok) {
      console.log(verdict.message);
      return;
    }
  }
  disk.windows = [snap.live.start, ...disk.windows].slice(0, 40);
  saveDisk(disk);
  const placed = local
    ? await placeLiveOrder({ tokenId: assetId, amount: stake, maxPrice })
    : await placeRemote(order);
  if (placed.ok) {
    disk.spent += stake;
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
  const session = await connectLive(readKey(), process.env.POLY_FUNDER ?? "");
  console.log(`Bot sur cette machine · ${session.wallet} · plafond ${lossCap}$.`);
} else {
  console.log(`Bot sans clé locale · signer ${process.env.SIGNER_URL} · plafond ${lossCap}$.`);
}
for (;;) {
  try {
    await tick(disk);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
