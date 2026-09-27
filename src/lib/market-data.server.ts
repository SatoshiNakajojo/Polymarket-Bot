import { WINDOW_SEC, windowStartSec, type Quote, type Side } from "@/lib/engine";
import type { PricePoint, Snapshot, WindowView } from "@/lib/market-types";

export type { Snapshot } from "@/lib/market-types";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; Fenetre/1.0)",
  Accept: "application/json",
};

type Candle = { t: number; open: number; high: number; low: number; close: number };

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadBtcPrice(): Promise<number> {
  try {
    const ticker = (await getJson(
      "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
    )) as { price?: string };
    const price = Number(ticker.price);
    if (price > 0) return price;
  } catch {
    /* fall through */
  }
  const kraken = (await getJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD")) as {
    result?: { XXBTZUSD?: { c?: string[] } };
  };
  const price = Number(kraken.result?.XXBTZUSD?.c?.[0]);
  if (!(price > 0)) throw new Error("Prix BTC indisponible.");
  return price;
}

function parseCoinbase(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      if (!Array.isArray(row)) return null;
      const [t, low, high, open, close] = row.map(Number);
      if (![t, low, high, open, close].every((n) => Number.isFinite(n))) return null;
      return { t, low, high, open, close };
    })
    .filter((c): c is Candle => c != null)
    .sort((a, b) => a.t - b.t);
}

function parseKraken(raw: unknown): Candle[] {
  const result = (raw as { result?: Record<string, unknown> }).result;
  if (!result) return [];
  const rows = Object.values(result).find((v) => Array.isArray(v)) as unknown[] | undefined;
  if (!rows) return [];
  return rows
    .map((row) => {
      if (!Array.isArray(row)) return null;
      const [t, open, high, low, close] = row.map(Number);
      if (![t, open, high, low, close].every((n) => Number.isFinite(n))) return null;
      return { t, open, high, low, close };
    })
    .filter((c): c is Candle => c != null)
    .sort((a, b) => a.t - b.t);
}

async function loadCandles(start: number, end: number): Promise<Candle[]> {
  const startIso = new Date(start * 1000).toISOString();
  const endIso = new Date(end * 1000).toISOString();
  try {
    const raw = await getJson(
      `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`,
    );
    const candles = parseCoinbase(raw);
    if (candles.length > 0) return candles;
  } catch {
    /* fall through */
  }
  const raw = await getJson("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1");
  return parseKraken(raw).filter((c) => c.t >= start - 120 && c.t <= end + 120);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [];
    }
  }
  return [];
}

function level(levels: unknown, mode: "bid" | "ask"): { price: number; size: number } | null {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  let best: { price: number; size: number } | null = null;
  for (const row of levels) {
    const price = Number((row as { price?: string }).price);
    const size = Number((row as { size?: string }).size);
    if (!(price > 0) || !(size >= 0)) continue;
    if (!best) {
      best = { price, size };
      continue;
    }
    if (mode === "bid" && price > best.price) best = { price, size };
    if (mode === "ask" && price < best.price) best = { price, size };
  }
  return best;
}

async function loadBook(tokenId: string): Promise<{ quote: Quote; minSize: number | null }> {
  const book = (await getJson(
    `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
  )) as {
    bids?: unknown;
    asks?: unknown;
    min_order_size?: string | number;
  };
  const bid = level(book.bids, "bid");
  const ask = level(book.asks, "ask");
  const minSize = Number(book.min_order_size);
  return {
    quote: {
      bid: bid?.price ?? null,
      ask: ask?.price ?? null,
      askSize: ask?.size ?? null,
    },
    minSize: Number.isFinite(minSize) && minSize > 0 ? minSize : null,
  };
}

function summarize(
  candles: Candle[],
  start: number,
  end: number,
  now: number,
  livePrice: number,
  closed: boolean,
): WindowView {
  const spanEnd = closed ? end : Math.min(now, end);
  const elapsed = Math.max(0, spanEnd - start);
  const remaining = Math.max(0, end - (closed ? end : now));
  const inside = candles.filter((c) => c.t >= start - 1 && c.t < end);
  const opener = inside.find((c) => Math.abs(c.t - start) < 2) ?? inside[0];
  const strike = opener?.open ?? livePrice;

  let acc = 0;
  let covered = 0;
  const path: PricePoint[] = [];
  for (const candle of inside) {
    const segStart = Math.max(candle.t, start);
    const segEnd = Math.min(candle.t + 60, spanEnd);
    if (segEnd <= segStart) continue;
    const liveMinute = !closed && now >= candle.t && now < candle.t + 60;
    const px = liveMinute ? livePrice : (candle.open + candle.close) / 2;
    const dur = segEnd - segStart;
    acc += px * dur;
    covered += dur;
    path.push({ t: segEnd, price: liveMinute ? livePrice : candle.close });
  }
  if (covered + 0.5 < elapsed) {
    acc += livePrice * (elapsed - covered);
  }
  if (!closed && (path.length === 0 || (path[path.length - 1]?.t ?? 0) < now - 1)) {
    path.push({ t: now, price: livePrice });
  }
  const twap = elapsed > 0 ? acc / Math.max(covered, elapsed) : livePrice;
  return {
    start,
    end,
    strike,
    twap,
    elapsed,
    remaining,
    complete: closed || now >= end,
    path,
  };
}

function sigmaFrom(candles: Candle[], start: number): number {
  const prior = candles.filter((c) => c.t < start && c.t >= start - 3600);
  const diffs: number[] = [];
  for (let i = 1; i < prior.length; i++) {
    const prev = prior[i - 1];
    const curr = prior[i];
    if (prev && curr) diffs.push(curr.close - prev.close);
  }
  if (diffs.length < 8) return 4;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance =
    diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diffs.length - 1);
  const perSqrtSec = Math.sqrt(Math.max(0, variance)) / Math.sqrt(60);
  if (!Number.isFinite(perSqrtSec)) return 4;
  return Math.min(25, Math.max(1, perSqrtSec));
}

async function loadSettled(start: number, now: number): Promise<{ start: number; outcome: Side } | null> {
  if (now < start + WINDOW_SEC) return null;
  const slug = `btc-updown-5m-${start}`;
  const events = await getJson(`https://gamma-api.polymarket.com/events?slug=${slug}`).catch(() => []);
  const event = Array.isArray(events) ? (events[0] as { markets?: unknown[] } | undefined) : undefined;
  const market = Array.isArray(event?.markets) ? (event.markets[0] as Record<string, unknown>) : undefined;
  if (!market) return null;
  const outcomes = asStringArray(market.outcomes);
  const prices = asStringArray(market.outcomePrices).map(Number);
  const index = prices.findIndex((price, i) => price >= 0.99 && prices.every((other, j) => j === i || other <= 0.01));
  if (market.closed !== true && index < 0) return null;
  const name = outcomes[index]?.toLowerCase();
  if (name !== "up" && name !== "down") return null;
  return { start, outcome: name === "up" ? "Up" : "Down" };
}

export async function loadSnapshot(): Promise<Snapshot> {
  const serverNow = Date.now() / 1000;
  const start = windowStartSec(serverNow);
  try {
    const slug = `btc-updown-5m-${start}`;
    const [price, candles, events, settled] = await Promise.all([
      loadBtcPrice(),
      loadCandles(start - 3900, serverNow + 5),
      getJson(`https://gamma-api.polymarket.com/events?slug=${slug}`).catch(() => []),
      Promise.all(
        [1, 2, 3, 4, 5, 6].map((n) => loadSettled(start - n * WINDOW_SEC, serverNow)),
      ),
    ]);

    const event = Array.isArray(events) ? (events[0] as Record<string, unknown> | undefined) : undefined;
    const marketRaw = Array.isArray(event?.markets)
      ? (event.markets[0] as Record<string, unknown> | undefined)
      : undefined;

    let market: Extract<Snapshot, { ok: true }>["market"] = null;
    let feeRate = 0.07;
    let minOrderSize = 5;

    if (marketRaw) {
      const outcomes = asStringArray(marketRaw.outcomes);
      const tokens = asStringArray(marketRaw.clobTokenIds);
      const upIndex = outcomes.findIndex((o) => o.toLowerCase() === "up");
      const downIndex = outcomes.findIndex((o) => o.toLowerCase() === "down");
      const schedule = marketRaw.feeSchedule as { rate?: number } | undefined;
      if (typeof schedule?.rate === "number" && schedule.rate > 0 && schedule.rate < 1) {
        feeRate = schedule.rate;
      }
      const upToken = upIndex >= 0 ? tokens[upIndex] : undefined;
      const downToken = downIndex >= 0 ? tokens[downIndex] : undefined;
      if (upToken && downToken) {
        const [upBook, downBook] = await Promise.all([
          loadBook(upToken).catch(() => null),
          loadBook(downToken).catch(() => null),
        ]);
        const mins = [upBook?.minSize, downBook?.minSize].filter((n): n is number => n != null);
        if (mins.length) minOrderSize = Math.max(...mins);
        market = {
          slug,
          title: String(event?.title ?? marketRaw.question ?? slug),
          acceptingOrders: marketRaw.acceptingOrders !== false,
          upToken,
          downToken,
          up: upBook?.quote ?? { bid: null, ask: null, askSize: null },
          down: downBook?.quote ?? { bid: null, ask: null, askSize: null },
        };
      }
    }

    return {
      ok: true,
      serverNow,
      price,
      sigmaPerSqrtSec: sigmaFrom(candles, start),
      feeRate,
      minOrderSize,
      live: summarize(candles, start, start + WINDOW_SEC, serverNow, price, false),
      previous: summarize(
        candles,
        start - WINDOW_SEC,
        start,
        serverNow,
        price,
        true,
      ),
      settled: settled.filter((row): row is { start: number; outcome: Side } => row != null),
      market,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lecture du marché impossible.";
    return { ok: false, error: message, serverNow };
  }
}
