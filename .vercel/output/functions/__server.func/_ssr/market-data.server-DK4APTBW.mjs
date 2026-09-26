import { o as windowStartSec } from "./engine-DkAqhIrm.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/market-data.server-DK4APTBW.js
var HEADERS = {
	"User-Agent": "Mozilla/5.0 (compatible; Fenetre/1.0)",
	Accept: "application/json"
};
async function getJson(url) {
	const res = await fetch(url, {
		headers: HEADERS,
		signal: AbortSignal.timeout(8e3)
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}
async function loadBtcPrice() {
	try {
		const ticker = await getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker");
		const price = Number(ticker.price);
		if (price > 0) return price;
	} catch {}
	const kraken = await getJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
	const price = Number(kraken.result?.XXBTZUSD?.c?.[0]);
	if (!(price > 0)) throw new Error("Prix BTC indisponible.");
	return price;
}
function parseCoinbase(raw) {
	if (!Array.isArray(raw)) return [];
	return raw.map((row) => {
		if (!Array.isArray(row)) return null;
		const [t, low, high, open, close] = row.map(Number);
		if (![
			t,
			low,
			high,
			open,
			close
		].every((n) => Number.isFinite(n))) return null;
		return {
			t,
			low,
			high,
			open,
			close
		};
	}).filter((c) => c != null).sort((a, b) => a.t - b.t);
}
function parseKraken(raw) {
	const result = raw.result;
	if (!result) return [];
	const rows = Object.values(result).find((v) => Array.isArray(v));
	if (!rows) return [];
	return rows.map((row) => {
		if (!Array.isArray(row)) return null;
		const [t, open, high, low, close] = row.map(Number);
		if (![
			t,
			open,
			high,
			low,
			close
		].every((n) => Number.isFinite(n))) return null;
		return {
			t,
			open,
			high,
			low,
			close
		};
	}).filter((c) => c != null).sort((a, b) => a.t - b.t);
}
async function loadCandles(start, end) {
	const startIso = (/* @__PURE__ */ new Date(start * 1e3)).toISOString();
	const endIso = (/* @__PURE__ */ new Date(end * 1e3)).toISOString();
	try {
		const candles = parseCoinbase(await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`));
		if (candles.length > 0) return candles;
	} catch {}
	return parseKraken(await getJson("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1")).filter((c) => c.t >= start - 120 && c.t <= end + 120);
}
function asStringArray(value) {
	if (Array.isArray(value)) return value.map(String);
	if (typeof value === "string") try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.map(String);
	} catch {
		return [];
	}
	return [];
}
function level(levels, mode) {
	if (!Array.isArray(levels) || levels.length === 0) return null;
	let best = null;
	for (const row of levels) {
		const price = Number(row.price);
		const size = Number(row.size);
		if (!(price > 0) || !(size >= 0)) continue;
		if (!best) {
			best = {
				price,
				size
			};
			continue;
		}
		if (mode === "bid" && price > best.price) best = {
			price,
			size
		};
		if (mode === "ask" && price < best.price) best = {
			price,
			size
		};
	}
	return best;
}
async function loadBook(tokenId) {
	const book = await getJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
	const bid = level(book.bids, "bid");
	const ask = level(book.asks, "ask");
	const minSize = Number(book.min_order_size);
	return {
		quote: {
			bid: bid?.price ?? null,
			ask: ask?.price ?? null,
			askSize: ask?.size ?? null
		},
		minSize: Number.isFinite(minSize) && minSize > 0 ? minSize : null
	};
}
function summarize(candles, start, end, now, livePrice, closed) {
	const spanEnd = closed ? end : Math.min(now, end);
	const elapsed = Math.max(0, spanEnd - start);
	const remaining = Math.max(0, end - (closed ? end : now));
	const inside = candles.filter((c) => c.t >= start - 1 && c.t < end);
	const strike = (inside.find((c) => Math.abs(c.t - start) < 2) ?? inside[0])?.open ?? livePrice;
	let acc = 0;
	let covered = 0;
	const path = [];
	for (const candle of inside) {
		const segStart = Math.max(candle.t, start);
		const segEnd = Math.min(candle.t + 60, spanEnd);
		if (segEnd <= segStart) continue;
		const liveMinute = !closed && now >= candle.t && now < candle.t + 60;
		const px = liveMinute ? livePrice : (candle.open + candle.close) / 2;
		const dur = segEnd - segStart;
		acc += px * dur;
		covered += dur;
		path.push({
			t: segEnd,
			price: liveMinute ? livePrice : candle.close
		});
	}
	if (covered + .5 < elapsed) acc += livePrice * (elapsed - covered);
	if (!closed && (path.length === 0 || (path[path.length - 1]?.t ?? 0) < now - 1)) path.push({
		t: now,
		price: livePrice
	});
	return {
		start,
		end,
		strike,
		twap: elapsed > 0 ? acc / Math.max(covered, elapsed) : livePrice,
		elapsed,
		remaining,
		complete: closed || now >= end,
		path
	};
}
function sigmaFrom(candles, start) {
	const prior = candles.filter((c) => c.t < start && c.t >= start - 3600);
	const diffs = [];
	for (let i = 1; i < prior.length; i++) {
		const prev = prior[i - 1];
		const curr = prior[i];
		if (prev && curr) diffs.push(curr.close - prev.close);
	}
	if (diffs.length < 8) return 4;
	const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
	const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diffs.length - 1);
	const perSqrtSec = Math.sqrt(Math.max(0, variance)) / Math.sqrt(60);
	if (!Number.isFinite(perSqrtSec)) return 4;
	return Math.min(25, Math.max(1, perSqrtSec));
}
async function loadSnapshot() {
	const serverNow = Date.now() / 1e3;
	const start = windowStartSec(serverNow);
	try {
		const slug = `btc-updown-5m-${start}`;
		const [price, candles, events] = await Promise.all([
			loadBtcPrice(),
			loadCandles(start - 3900, serverNow + 5),
			getJson(`https://gamma-api.polymarket.com/events?slug=${slug}`).catch(() => [])
		]);
		const event = Array.isArray(events) ? events[0] : void 0;
		const marketRaw = Array.isArray(event?.markets) ? event.markets[0] : void 0;
		let market = null;
		let feeRate = .07;
		let minOrderSize = 5;
		if (marketRaw) {
			const outcomes = asStringArray(marketRaw.outcomes);
			const tokens = asStringArray(marketRaw.clobTokenIds);
			const upIndex = outcomes.findIndex((o) => o.toLowerCase() === "up");
			const downIndex = outcomes.findIndex((o) => o.toLowerCase() === "down");
			const schedule = marketRaw.feeSchedule;
			if (typeof schedule?.rate === "number" && schedule.rate > 0 && schedule.rate < 1) feeRate = schedule.rate;
			const upToken = upIndex >= 0 ? tokens[upIndex] : void 0;
			const downToken = downIndex >= 0 ? tokens[downIndex] : void 0;
			if (upToken && downToken) {
				const [upBook, downBook] = await Promise.all([loadBook(upToken).catch(() => null), loadBook(downToken).catch(() => null)]);
				const mins = [upBook?.minSize, downBook?.minSize].filter((n) => n != null);
				if (mins.length) minOrderSize = Math.max(...mins);
				market = {
					slug,
					title: String(event?.title ?? marketRaw.question ?? slug),
					acceptingOrders: marketRaw.acceptingOrders !== false,
					up: upBook?.quote ?? {
						bid: null,
						ask: null,
						askSize: null
					},
					down: downBook?.quote ?? {
						bid: null,
						ask: null,
						askSize: null
					}
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
			live: summarize(candles, start, start + 300, serverNow, price, false),
			previous: summarize(candles, start - 300, start, serverNow, price, true),
			market
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Lecture du marché impossible.",
			serverNow
		};
	}
}
//#endregion
export { loadSnapshot };
