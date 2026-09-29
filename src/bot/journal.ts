/**
 * Journal BTC 5 min : observe chaque fenêtre sans jamais trader ni lire de clé.
 *
 * Toutes les 15 s de chaque fenêtre, il note la probabilité du modèle TWAP 60 s
 * et le carnet Polymarket, puis le résultat officiel une fois la fenêtre réglée.
 *   npm run journal          enregistre (laisser tourner)
 *   npm run journal:score    lit le journal et dit si le modèle bat le marché
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import {
  TWAP_SEC,
  WINDOW_SEC,
  fairUpTwap60,
  sigmaFromCloses,
  stepAverage,
  valueAt,
  type Tick,
} from "./journal-model.ts";

const DIR = process.env.JOURNAL_DIR ?? "data/journal";
const OBS_FILE = `${DIR}/observations.csv`;
const OUT_FILE = `${DIR}/resultats.jsonl`;
const STEP = 15;
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; FenetreJournal/1.0)", Accept: "application/json" };

const OBS_COLUMNS = [
  "ts",
  "window",
  "elapsed",
  "remaining",
  "spot",
  "spot_src",
  "strike",
  "strike_src",
  "locked",
  "sigma",
  "p_model",
  "up_bid",
  "up_ask",
  "up_size",
  "down_bid",
  "down_ask",
  "down_size",
  "fee_rate",
  "min_size",
  "up_bid_size",
  "up_bid_depth",
  "up_ask_depth",
  "ret15",
  "ret60",
  "ret300",
] as const;

/** Profondeur cumulée jusqu'à 3 c du meilleur prix. */
const DEPTH_BAND = 0.03;

type Quote = {
  bid: number | null;
  ask: number | null;
  size: number | null;
  bidSize: number | null;
  bidDepth: number | null;
  askDepth: number | null;
};
type WindowInfo = {
  slug: string;
  upToken: string;
  downToken: string;
  feeRate: number;
  minSize: number;
  meta: unknown;
};

const chainlink: Tick[] = [];
const twap: Tick[] = [];
const coinbase: Tick[] = [];
let lastStreamAt = 0;
let lastStreamLog = 0;

const windows = new Map<number, WindowInfo>();
const sigmas = new Map<number, number>();
const strikes = new Map<number, { value: number; src: string }>();
const inflight = new Set<string>();
const done = new Set<string>();
const pending = new Set<number>();
const resolved = new Set<number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Date.now() / 1000;
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString("fr-FR");

function push(series: Tick[], t: number, v: number) {
  if (!(v > 0) || !(t > 0)) return;
  const last = series[series.length - 1];
  if (last && t < last.t) return;
  if (last && t === last.t) last.v = v;
  else series.push({ t, v });
  const cutoff = t - 1200;
  while (series.length > 0 && series[0].t < cutoff) series.shift();
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function isBtc(symbol: unknown): boolean {
  return String(symbol).toLowerCase().replace(/[^a-z]/g, "") === "btcusd";
}

/** Flux Chainlink de Polymarket : prix instantané et TWAP 60 s officielle. */
async function stream() {
  const { createPublicClient } = await import("@polymarket/client");
  const client = createPublicClient();
  for (;;) {
    try {
      const handle = await client.subscribe([
        { topic: "prices.crypto.chainlink" },
        { topic: "prices.crypto.chainlink.twap", windowSeconds: 60 },
      ]);
      lastStreamAt = nowSec();
      const watchdog = setInterval(() => {
        if (nowSec() - lastStreamAt > 30) void handle.close();
      }, 5000);
      try {
        for await (const event of handle) {
          const payload = event.payload as { symbol?: unknown; value?: unknown; timestamp?: unknown };
          if (!isBtc(payload.symbol)) continue;
          const t = Number(payload.timestamp) / 1000;
          const v = Number(payload.value);
          lastStreamAt = nowSec();
          if (event.topic === "prices.crypto.chainlink.twap") push(twap, t, v);
          else if (event.topic === "prices.crypto.chainlink") push(chainlink, t, v);
        }
      } finally {
        clearInterval(watchdog);
      }
      console.log("Flux Chainlink coupé, reconnexion…");
    } catch (error) {
      if (nowSec() - lastStreamLog > 60) {
        lastStreamLog = nowSec();
        console.log(
          `Flux Chainlink indisponible (${error instanceof Error ? error.message : error}). Prix Coinbase en secours, on réessaie.`,
        );
      }
    }
    await sleep(3000);
  }
}

/** Prix Coinbase en secours, et pour comparer les sources. */
async function pollCoinbase() {
  for (;;) {
    try {
      const ticker = (await getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker")) as {
        price?: string;
      };
      push(coinbase, nowSec(), Number(ticker.price));
    } catch {
      /* on réessaie au tour suivant */
    }
    await sleep(2000);
  }
}

async function loadCloses(): Promise<number[]> {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 3600_000).toISOString();
  try {
    const raw = (await getJson(
      `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    )) as number[][];
    const rows = raw.filter((r) => Array.isArray(r) && r.length >= 5).sort((a, b) => a[0] - b[0]);
    if (rows.length >= 20) return rows.map((r) => Number(r[4]));
  } catch {
    /* Kraken en secours */
  }
  const raw = (await getJson("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1")) as {
    result?: Record<string, unknown>;
  };
  const rows = Object.values(raw.result ?? {}).find((v) => Array.isArray(v)) as unknown[][] | undefined;
  return (rows ?? []).slice(-60).map((r) => Number(r[4]));
}

async function loadWindow(start: number): Promise<WindowInfo | null> {
  const slug = `btc-updown-5m-${start}`;
  const events = (await getJson(`https://gamma-api.polymarket.com/events?slug=${slug}`)) as unknown[];
  const event = Array.isArray(events) ? (events[0] as Record<string, unknown> | undefined) : undefined;
  const market = Array.isArray(event?.markets) ? (event.markets[0] as Record<string, unknown>) : undefined;
  if (!market) return null;
  const outcomes = strings(market.outcomes).map((o) => o.toLowerCase());
  const tokens = strings(market.clobTokenIds);
  const upToken = tokens[outcomes.indexOf("up")];
  const downToken = tokens[outcomes.indexOf("down")];
  if (!upToken || !downToken) return null;
  const schedule = market.feeSchedule as { rate?: number } | undefined;
  const rate = typeof schedule?.rate === "number" && schedule.rate > 0 && schedule.rate < 1 ? schedule.rate : 0.07;
  const minSize = Number(market.orderMinSize);
  return {
    slug,
    upToken,
    downToken,
    feeRate: rate,
    minSize: minSize > 0 ? minSize : 5,
    meta: event?.eventMetadata ?? null,
  };
}

async function loadBook(tokenId: string): Promise<Quote> {
  const book = (await getJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`)) as {
    bids?: { price: string; size: string }[];
    asks?: { price: string; size: string }[];
  };
  const levels = (rows: { price: string; size: string }[] | undefined) =>
    (rows ?? []).map((r) => ({ price: Number(r.price), size: Number(r.size) })).filter((l) => l.price > 0 && l.size >= 0);
  const bids = levels(book.bids).sort((a, b) => b.price - a.price);
  const asks = levels(book.asks).sort((a, b) => a.price - b.price);
  const bid = bids[0]?.price ?? null;
  const ask = asks[0]?.price ?? null;
  const depth = (side: typeof bids, best: number | null) =>
    best == null
      ? null
      : side.filter((l) => Math.abs(l.price - best) <= DEPTH_BAND + 1e-9).reduce((sum, l) => sum + l.size, 0);
  return {
    bid,
    ask,
    size: asks[0]?.size ?? null,
    bidSize: bids[0]?.size ?? null,
    bidDepth: depth(bids, bid),
    askDepth: depth(asks, ask),
  };
}

async function officialOutcome(start: number): Promise<"Up" | "Down" | null> {
  const events = (await getJson(`https://gamma-api.polymarket.com/events?slug=btc-updown-5m-${start}`)) as unknown[];
  const event = Array.isArray(events) ? (events[0] as Record<string, unknown> | undefined) : undefined;
  const market = Array.isArray(event?.markets) ? (event.markets[0] as Record<string, unknown>) : undefined;
  if (!market) return null;
  const outcomes = strings(market.outcomes).map((o) => o.toLowerCase());
  const prices = strings(market.outcomePrices).map(Number);
  const index = prices.findIndex((p, i) => p >= 0.99 && prices.every((q, j) => j === i || q <= 0.01));
  if (index < 0) return null;
  const name = outcomes[index];
  return name === "up" ? "Up" : name === "down" ? "Down" : null;
}

/** Spot Chainlink s'il est frais, sinon Coinbase. */
function spotNow(t: number): { value: number; src: string } | null {
  const cl = valueAt(chainlink, t, 10);
  if (cl != null) return { value: cl, src: "chainlink" };
  const cb = valueAt(coinbase, t, 10);
  return cb != null ? { value: cb, src: "coinbase" } : null;
}

/** TWAP 60 s à l'instant t : flux officiel, sinon recalculée depuis le spot. */
function twapAt(t: number): { value: number; src: string } | null {
  const official = valueAt(twap, t, 10);
  if (official != null) return { value: official, src: "twap60" };
  const cl = stepAverage(chainlink, t - TWAP_SEC, t);
  if (cl != null) return { value: cl, src: "chainlink60" };
  const cb = stepAverage(coinbase, t - TWAP_SEC, t);
  return cb != null ? { value: cb, src: "coinbase60" } : null;
}

/** Rendement log du prix sur les k dernières secondes, même source que le spot. */
function recentReturn(src: string, spot: number, t: number, k: number): number | null {
  const series = src === "chainlink" ? chainlink : coinbase;
  const past = valueAt(series, t - k, 10);
  return past != null && past > 0 ? Math.log(spot / past) : null;
}

function lockedAvg(end: number, t: number): number | null {
  const from = end - TWAP_SEC;
  if (t <= from) return null;
  return stepAverage(chainlink, from, t) ?? stepAverage(coinbase, from, t);
}

function once(key: string, job: () => Promise<void>) {
  if (inflight.has(key)) return;
  inflight.add(key);
  void job()
    .catch(() => undefined)
    .finally(() => inflight.delete(key));
}

const fmt = (n: number | null | undefined, digits = 4) => (n == null || !Number.isFinite(n) ? "" : n.toFixed(digits));

async function record(start: number, checkpoint: number) {
  const info = windows.get(start);
  const sigma = sigmas.get(start);
  const strike = strikes.get(start);
  const t = nowSec();
  const spot = spotNow(t);
  if (!info || sigma == null || !strike || !spot) return;
  const [up, down] = await Promise.all([loadBook(info.upToken), loadBook(info.downToken)]);
  const remaining = start + WINDOW_SEC - t;
  const locked = lockedAvg(start + WINDOW_SEC, t);
  const model = fairUpTwap60({ strike: strike.value, spot: spot.value, lockedAvg: locked, remainingSec: remaining, sigma });
  const row = [
    t.toFixed(1),
    start,
    (t - start).toFixed(1),
    remaining.toFixed(1),
    fmt(spot.value, 2),
    spot.src,
    fmt(strike.value, 2),
    strike.src,
    fmt(locked, 2),
    fmt(sigma, 3),
    fmt(model.p),
    fmt(up.bid, 3),
    fmt(up.ask, 3),
    fmt(up.size, 2),
    fmt(down.bid, 3),
    fmt(down.ask, 3),
    fmt(down.size, 2),
    info.feeRate,
    info.minSize,
    fmt(up.bidSize, 2),
    fmt(up.bidDepth, 2),
    fmt(up.askDepth, 2),
    fmt(recentReturn(spot.src, spot.value, t, 15), 7),
    fmt(recentReturn(spot.src, spot.value, t, 60), 7),
    fmt(recentReturn(spot.src, spot.value, t, 300), 7),
  ];
  appendFileSync(OBS_FILE, `${row.join(",")}\n`);
  done.add(`${start}:${checkpoint}`);
  pending.add(start);
  const mid = up.bid != null && up.ask != null ? Math.round(((up.bid + up.ask) / 2) * 100) : "?";
  console.log(
    `${clock(t)} · fenêtre ${clock(start)} +${checkpoint} s · modèle Up ${Math.round(model.p * 100)} % · marché Up ${mid} c · écart au strike ${(spot.value - strike.value).toFixed(0)} $ · ${spot.src}/${strike.src}`,
  );
}

async function resolve(start: number) {
  const outcome = await officialOutcome(start);
  if (!outcome) {
    if (nowSec() - start > 3 * 3600) pending.delete(start);
    return;
  }
  const strike = strikes.get(start) ?? null;
  const final = twapAt(start + WINDOW_SEC);
  const journal = strike && final ? (final.value >= strike.value ? "Up" : "Down") : null;
  const line = {
    window: start,
    outcome,
    strike: strike?.value ?? null,
    strike_src: strike?.src ?? null,
    final: final?.value ?? null,
    final_src: final?.src ?? null,
    journal_outcome: journal,
    meta: windows.get(start)?.meta ?? null,
  };
  appendFileSync(OUT_FILE, `${JSON.stringify(line)}\n`);
  pending.delete(start);
  resolved.add(start);
  const check = journal == null ? "" : journal === outcome ? " · reconstitution OK" : " · reconstitution DIFFÉRENTE";
  console.log(`Fenêtre ${clock(start)} réglée : ${outcome}${check}`);
}

function restore() {
  mkdirSync(DIR, { recursive: true });
  // Un ancien fichier aux colonnes différentes est gardé à côté : le score lit les deux.
  if (existsSync(OBS_FILE)) {
    const head = readFileSync(OBS_FILE, "utf8").split("\n")[0];
    if (head !== OBS_COLUMNS.join(",")) {
      renameSync(OBS_FILE, `${DIR}/observations-${Math.floor(nowSec())}.csv`);
    }
  }
  if (!existsSync(OBS_FILE)) appendFileSync(OBS_FILE, `${OBS_COLUMNS.join(",")}\n`);
  if (existsSync(OUT_FILE)) {
    for (const line of readFileSync(OUT_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        resolved.add(Number((JSON.parse(line) as { window: number }).window));
      } catch {
        /* ligne abîmée : ignorée */
      }
    }
  }
  const lines = readFileSync(OBS_FILE, "utf8").split("\n").slice(1);
  for (const line of lines) {
    const cells = line.split(",");
    const start = Number(cells[1]);
    if (!(start > 0) || resolved.has(start) || nowSec() - start >= 3 * 3600) continue;
    pending.add(start);
    const strike = Number(cells[OBS_COLUMNS.indexOf("strike")]);
    if (strike > 0) strikes.set(start, { value: strike, src: cells[OBS_COLUMNS.indexOf("strike_src")] });
  }
}

async function main() {
  restore();
  console.log(`Journal BTC 5 min · aucun ordre, aucune clé · fichiers dans ${DIR}/`);
  void stream();
  void pollCoinbase();
  let lastResolve = 0;
  for (;;) {
    const t = nowSec();
    const start = Math.floor(t / WINDOW_SEC) * WINDOW_SEC;
    const elapsed = t - start;

    if (!windows.has(start)) {
      once(`w${start}`, async () => {
        const info = await loadWindow(start);
        if (info) windows.set(start, info);
      });
    }
    if (!sigmas.has(start)) {
      once(`s${start}`, async () => {
        const sigma = sigmaFromCloses(await loadCloses());
        if (sigma != null) sigmas.set(start, sigma);
      });
    }
    // Le strike est la TWAP 60 s à l'ouverture. Il faut avoir écouté la minute d'avant.
    if (!strikes.has(start) && elapsed >= 3) {
      const strike = twapAt(start);
      if (strike) strikes.set(start, strike);
    }

    const checkpoint = Math.floor(elapsed / STEP) * STEP;
    const key = `${start}:${checkpoint}`;
    if (checkpoint >= STEP && checkpoint < WINDOW_SEC && elapsed - checkpoint < 5 && !done.has(key)) {
      once(`r${key}`, () => record(start, checkpoint));
    }

    if (t - lastResolve > 20) {
      lastResolve = t;
      for (const w of pending) {
        if (t >= w + WINDOW_SEC + 20) once(`o${w}`, () => resolve(w));
      }
    }

    for (const w of windows.keys()) if (w < start - 3 * 3600) windows.delete(w);
    for (const w of sigmas.keys()) if (w < start - 3600) sigmas.delete(w);
    for (const w of strikes.keys()) if (w < start - 3 * 3600) strikes.delete(w);
    for (const k of done) if (Number(k.split(":")[0]) < start - 600) done.delete(k);
    await sleep(1000);
  }
}

export { main as startJournal };

// Lancé directement (npm run journal) : on démarre. Importé (npm run paper) : l'appelant décide.
if (process.argv[1]?.endsWith("journal.ts")) await main();
