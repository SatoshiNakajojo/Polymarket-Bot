/**
 * Teneur de marché en papier, 24 h/24 : suit le carnet et les transactions de
 * chaque fenêtre BTC 5 min en temps réel et simule nos ordres limites
 * (maker.ts), avec plusieurs réglages en parallèle sur le même flux.
 * Aucune clé, aucun ordre réel.
 *   npm run maker
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { loadWindow, officialOutcome } from "./journal.ts";
import { MakerSim, VARIANTS, type Level, type Side } from "./maker.ts";

const DIR = process.env.MAKER_DIR ?? "data/maker";
const RESULTS = `${DIR}/resultats.jsonl`;
const FILLS = `${DIR}/executions.jsonl`;
const STATE = `${DIR}/etat.json`;
const WINDOW = 300;

type Sims = Map<string, MakerSim>;
type Live = {
  start: number;
  sims: Sims;
  sideOf: Map<string, Side>;
  close: () => void;
  lastEvent: number;
  stream: "direct" | "secours";
  printed: number;
};

let current: Live | null = null;
let opening = false;
const toSettle = new Map<number, Sims>();
let lastState = 0;

const nowSec = () => Date.now() / 1000;
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString("fr-FR");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const levels = (rows: unknown): Level[] =>
  (Array.isArray(rows) ? rows : [])
    .map((r) => ({ price: Number((r as { price?: unknown }).price), size: Number((r as { size?: unknown }).size) }))
    .filter((l) => l.price > 0 && l.size >= 0);

function newSims(): Sims {
  return new Map(VARIANTS.map((v) => [v.key, new MakerSim(v.params)]));
}

async function restBooks(live: Live) {
  for (const [token, side] of live.sideOf) {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) continue;
    const book = (await res.json()) as { bids?: unknown; asks?: unknown };
    for (const sim of live.sims.values()) sim.onBook(side, levels(book.bids), levels(book.asks), nowSec());
  }
}

type AnyEvent = { type?: string; payload?: Record<string, unknown> };

function onEvent(live: Live, event: AnyEvent) {
  const t = nowSec();
  const p = event.payload ?? {};
  const each = (fn: (sim: MakerSim) => void) => {
    for (const sim of live.sims.values()) fn(sim);
  };
  if (event.type === "book") {
    const side = live.sideOf.get(String(p.assetId));
    if (side) each((sim) => sim.onBook(side, levels(p.bids), levels(p.asks), t));
  } else if (event.type === "price_change") {
    for (const c of (Array.isArray(p.priceChanges) ? p.priceChanges : []) as Record<string, unknown>[]) {
      const side = live.sideOf.get(String(c.assetId));
      if (side) each((sim) => sim.onLevel(side, c.side === "BUY" ? "bid" : "ask", Number(c.price), Number(c.size), t));
    }
  } else if (event.type === "last_trade_price") {
    const side = live.sideOf.get(String(p.assetId));
    const taker = p.side === "SELL" ? "SELL" : "BUY";
    if (side) each((sim) => sim.onTrade(side, Number(p.price), Number(p.size ?? 0), taker, t));
  } else {
    return;
  }
  live.lastEvent = t;
  live.stream = "direct";
  each((sim) => sim.requote(t, live.start + WINDOW - t));
  report(live);
}

/** Affiche les nouvelles exécutions du réglage de base. */
function report(live: Live) {
  const base = live.sims.get("base");
  if (!base) return;
  for (const f of base.fills.slice(live.printed)) {
    console.log(
      `maker · fenêtre ${clock(live.start)} · achat ${f.side} ${f.shares.toFixed(1)} parts à ${Math.round(f.price * 100)} c (${f.how}) · stock Up ${base.shares.Up.toFixed(0)} / Down ${base.shares.Down.toFixed(0)}`,
    );
  }
  live.printed = base.fills.length;
}

/** État en direct, lu par la page web. Écrit au plus toutes les 2 s. */
function writeState() {
  const t = nowSec();
  if (t - lastState < 2) return;
  lastState = t;
  const live = current;
  const state = {
    majA: new Date().toISOString(),
    fenetre: live?.start ?? null,
    restant: live ? Math.max(0, live.start + WINDOW - t) : null,
    flux: live?.stream ?? null,
    dernierEvenement: live?.lastEvent ? new Date(live.lastEvent * 1000).toISOString() : null,
    variantes: VARIANTS.map((v) => {
      const sim = live?.sims.get(v.key);
      const order = (s: Side) => {
        const o = sim?.orders[s];
        return o ? { prix: o.price, taille: o.size, rempli: o.filled, devant: o.ahead } : null;
      };
      return {
        cle: v.key,
        nom: v.label,
        reglages: sim?.params ?? null,
        pause: sim ? sim.pausedUntil > t : false,
        ordres: { Up: order("Up"), Down: order("Down") },
        stock: { Up: sim?.shares.Up ?? 0, Down: sim?.shares.Down ?? 0 },
        cout: sim ? sim.cost.Up + sim.cost.Down : 0,
        executions: (sim?.fills ?? []).slice(-12).map((f) => ({ ...f, t: new Date(f.t * 1000).toISOString() })),
      };
    }),
  };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${STATE}.tmp`, JSON.stringify(state));
  renameSync(`${STATE}.tmp`, STATE);
}

async function openWindow(start: number): Promise<Live | null> {
  const info = await loadWindow(start);
  if (!info) return null;
  const live: Live = {
    start,
    sims: newSims(),
    sideOf: new Map([
      [info.upToken, "Up"],
      [info.downToken, "Down"],
    ]),
    close: () => undefined,
    lastEvent: 0,
    stream: "secours",
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
  console.log(`Fenêtre ${clock(start)} · ordres papier sur Up et Down · ${VARIANTS.length} réglages.`);
  return live;
}

type Line = { variante?: string; pnl: number; pairPnl: number; fills: number };

function totals(key: string) {
  if (!existsSync(RESULTS)) return null;
  const rows = readFileSync(RESULTS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line)
    .filter((r) => (r.variante ?? "base") === key);
  const traded = rows.filter((r) => r.fills > 0);
  const n = traded.length;
  const total = traded.reduce((a, r) => a + r.pnl, 0);
  const pairs = traded.reduce((a, r) => a + r.pairPnl, 0);
  const mean = n ? total / n : 0;
  const se = n > 1 ? Math.sqrt(traded.reduce((a, r) => a + (r.pnl - mean) ** 2, 0) / (n - 1) / n) : Number.NaN;
  return { windows: rows.length, n, total, pairs, mean, se };
}

const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} $`;

async function settle(start: number, sims: Sims) {
  const outcome = await officialOutcome(start).catch(() => null);
  if (!outcome) {
    if (nowSec() - start > 3 * 3600) toSettle.delete(start);
    return;
  }
  if (!toSettle.has(start)) return;
  toSettle.delete(start);
  mkdirSync(DIR, { recursive: true });
  console.log(`Fenêtre ${clock(start)} réglée ${outcome}`);
  for (const v of VARIANTS) {
    const sim = sims.get(v.key);
    if (!sim) continue;
    const r = sim.settle(outcome);
    appendFileSync(RESULTS, `${JSON.stringify({ window: start, variante: v.key, outcome, ...r, params: sim.params })}\n`);
    for (const f of sim.fills) appendFileSync(FILLS, `${JSON.stringify({ window: start, variante: v.key, ...f })}\n`);
    const s = totals(v.key);
    const band = s && Number.isFinite(s.se) ? ` ± ${(2 * s.se).toFixed(2)}` : "";
    console.log(
      `   ${v.label.padEnd(10)} Up ${r.up.toFixed(0)} / Down ${r.down.toFixed(0)} · ${r.pairs.toFixed(0)} paires (${signed(r.pairPnl)}) · P&L ${signed(r.pnl)}` +
        (s ? ` · cumul ${signed(s.total)} sur ${s.n} fenêtres, ${signed(s.mean)}${band} par fenêtre` : ""),
    );
  }
}

async function main() {
  console.log(`Teneur de marché papier · aucune clé, aucun ordre réel · réglages : ${VARIANTS.map((v) => v.label).join(", ")} · résultats dans ${DIR}/`);
  let lastSettle = 0;
  for (;;) {
    const t = nowSec();
    const start = Math.floor(t / WINDOW) * WINDOW;
    if (current && current.start !== start) {
      current.close();
      toSettle.set(current.start, current.sims);
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
    const stale = current != null && t - current.lastEvent > 10;
    if (current) {
      if (stale) {
        current.stream = "secours";
        await restBooks(current).catch(() => undefined);
      }
      for (const sim of current.sims.values()) sim.requote(t, current.start + WINDOW - t);
      report(current);
    }
    try {
      writeState();
    } catch {
      /* l'état en direct n'est pas indispensable */
    }
    if (t - lastSettle > 20) {
      lastSettle = t;
      for (const [w, sims] of toSettle) if (t >= w + WINDOW + 20) void settle(w, sims);
    }
    await sleep(stale ? 3000 : 1000);
  }
}

await main();
