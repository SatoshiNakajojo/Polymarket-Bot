/**
 * Teneur de marché en papier, 24 h/24 : suit le carnet et les transactions de
 * chaque fenêtre BTC 5 min en temps réel et simule nos ordres limites (maker.ts).
 * Aucune clé, aucun ordre réel.
 *   npm run maker
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { loadWindow, officialOutcome } from "./journal.ts";
import { MakerSim, type Level, type MakerParams, type Side } from "./maker.ts";

const DIR = process.env.MAKER_DIR ?? "data/maker";
const RESULTS = `${DIR}/resultats.jsonl`;
const FILLS = `${DIR}/executions.jsonl`;
const WINDOW = 300;

const params: Partial<MakerParams> = {};
const envNum = (name: string) => (process.env[name] != null ? Number(process.env[name]) : undefined);
if (envNum("MAKER_SIZE")) params.quoteSize = envNum("MAKER_SIZE");
if (envNum("MAKER_IMBALANCE")) params.maxImbalance = envNum("MAKER_IMBALANCE");
if (envNum("MAKER_MAX_SIDE")) params.maxPerSide = envNum("MAKER_MAX_SIDE");
if (envNum("MAKER_STOP")) params.stopBeforeEnd = envNum("MAKER_STOP");

type Live = {
  start: number;
  sim: MakerSim;
  sideOf: Map<string, Side>;
  close: () => void;
  lastEvent: number;
  printed: number;
};

let current: Live | null = null;
let opening = false;
const toSettle = new Map<number, MakerSim>();

const nowSec = () => Date.now() / 1000;
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString("fr-FR");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const levels = (rows: unknown): Level[] =>
  (Array.isArray(rows) ? rows : [])
    .map((r) => ({ price: Number((r as { price?: unknown }).price), size: Number((r as { size?: unknown }).size) }))
    .filter((l) => l.price > 0 && l.size >= 0);

async function restBooks(live: Live) {
  for (const [token, side] of live.sideOf) {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) continue;
    const book = (await res.json()) as { bids?: unknown; asks?: unknown };
    live.sim.onBook(side, levels(book.bids), levels(book.asks), nowSec());
  }
}

type AnyEvent = { type?: string; payload?: Record<string, unknown> };

function onEvent(live: Live, event: AnyEvent) {
  const t = nowSec();
  const p = event.payload ?? {};
  live.lastEvent = t;
  if (event.type === "book") {
    const side = live.sideOf.get(String(p.assetId));
    if (side) live.sim.onBook(side, levels(p.bids), levels(p.asks), t);
  } else if (event.type === "price_change") {
    for (const c of (Array.isArray(p.priceChanges) ? p.priceChanges : []) as Record<string, unknown>[]) {
      const side = live.sideOf.get(String(c.assetId));
      if (side) live.sim.onLevel(side, c.side === "BUY" ? "bid" : "ask", Number(c.price), Number(c.size), t);
    }
  } else if (event.type === "last_trade_price") {
    const side = live.sideOf.get(String(p.assetId));
    const taker = p.side === "SELL" ? "SELL" : "BUY";
    if (side) live.sim.onTrade(side, Number(p.price), Number(p.size ?? 0), taker, t);
  } else {
    return;
  }
  live.sim.requote(t, live.start + WINDOW - t);
  report(live);
}

/** Affiche les nouvelles exécutions. */
function report(live: Live) {
  for (const f of live.sim.fills.slice(live.printed)) {
    console.log(
      `maker · fenêtre ${clock(live.start)} · achat ${f.side} ${f.shares.toFixed(1)} parts à ${Math.round(f.price * 100)} c (${f.how}) · stock Up ${live.sim.shares.Up.toFixed(0)} / Down ${live.sim.shares.Down.toFixed(0)}`,
    );
  }
  live.printed = live.sim.fills.length;
}

async function openWindow(start: number): Promise<Live | null> {
  const info = await loadWindow(start);
  if (!info) return null;
  const live: Live = {
    start,
    sim: new MakerSim(params),
    sideOf: new Map([
      [info.upToken, "Up"],
      [info.downToken, "Down"],
    ]),
    close: () => undefined,
    lastEvent: 0,
    printed: 0,
  };
  await restBooks(live).catch(() => undefined);
  try {
    const { createPublicClient } = await import("@polymarket/client");
    const handle = await createPublicClient().subscribe([{ topic: "market", assetIds: [info.upToken, info.downToken] }]);
    live.close = () => void handle.close().catch(() => undefined);
    void (async () => {
      try {
        for await (const event of handle) onEvent(live, event as unknown as AnyEvent);
      } catch (error) {
        console.log(`Flux du carnet coupé : ${error instanceof Error ? error.message : error}`);
      }
    })();
  } catch (error) {
    console.log(`Flux du carnet indisponible, carnet lu toutes les 3 s : ${error instanceof Error ? error.message : error}`);
  }
  console.log(`Fenêtre ${clock(start)} · ordres papier sur Up et Down.`);
  return live;
}

function totals() {
  if (!existsSync(RESULTS)) return null;
  const rows = readFileSync(RESULTS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { pnl: number; pairPnl: number; fills: number });
  const traded = rows.filter((r) => r.fills > 0);
  const n = traded.length;
  const total = traded.reduce((a, r) => a + r.pnl, 0);
  const pairs = traded.reduce((a, r) => a + r.pairPnl, 0);
  const mean = n ? total / n : 0;
  const se = n > 1 ? Math.sqrt(traded.reduce((a, r) => a + (r.pnl - mean) ** 2, 0) / (n - 1) / n) : Number.NaN;
  return { windows: rows.length, n, total, pairs, mean, se };
}

async function settle(start: number, sim: MakerSim) {
  const outcome = await officialOutcome(start).catch(() => null);
  if (!outcome) {
    if (nowSec() - start > 3 * 3600) toSettle.delete(start);
    return;
  }
  toSettle.delete(start);
  const r = sim.settle(outcome);
  mkdirSync(DIR, { recursive: true });
  appendFileSync(RESULTS, `${JSON.stringify({ window: start, outcome, ...r, params: sim.params })}\n`);
  for (const f of sim.fills) appendFileSync(FILLS, `${JSON.stringify({ window: start, ...f })}\n`);
  const s = totals();
  const band = s && Number.isFinite(s.se) ? ` ± ${(2 * s.se).toFixed(2)}` : "";
  console.log(
    `Fenêtre ${clock(start)} réglée ${outcome} · Up ${r.up.toFixed(0)} / Down ${r.down.toFixed(0)} parts · ${r.pairs.toFixed(0)} paires (+${r.pairPnl.toFixed(2)} $) · P&L ${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)} $`,
  );
  if (s) {
    console.log(
      `   Cumul : ${s.n} fenêtres avec exécutions sur ${s.windows} · ${s.total >= 0 ? "+" : ""}${s.total.toFixed(2)} $ (dont paires +${s.pairs.toFixed(2)} $) · ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(2)} $${band} par fenêtre`,
    );
  }
}

async function main() {
  console.log("Teneur de marché papier · aucune clé, aucun ordre réel · résultats dans " + DIR + "/");
  let lastSettle = 0;
  for (;;) {
    const t = nowSec();
    const start = Math.floor(t / WINDOW) * WINDOW;
    if (current && current.start !== start) {
      current.close();
      toSettle.set(current.start, current.sim);
      current = null;
    }
    if (!current && !opening) {
      opening = true;
      void openWindow(start)
        .then((live) => {
          if (live && live.start === Math.floor(nowSec() / WINDOW) * WINDOW) current = live;
          else live?.close();
        })
        .catch(() => undefined)
        .finally(() => {
          opening = false;
        });
    }
    if (current) {
      if (t - current.lastEvent > 10) {
        await restBooks(current).catch(() => undefined);
      }
      current.sim.requote(t, current.start + WINDOW - t);
      report(current);
    }
    if (t - lastSettle > 20) {
      lastSettle = t;
      for (const [w, sim] of toSettle) if (t >= w + WINDOW + 20) void settle(w, sim);
    }
    await sleep(current && t - current.lastEvent > 10 ? 3000 : 1000);
  }
}

await main();
