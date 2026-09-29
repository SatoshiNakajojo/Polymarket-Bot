import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Sample = { t: number; price: number };

const FILE = "data/chainlink.json";
const KEEP_SEC = 2 * 60 * 60;
const samples: Sample[] = [];
let started = false;
let socket: WebSocket | null = null;
let ready: Promise<void> | null = null;
let resolveReady: (() => void) | null = null;

function remember(tMs: number, price: number) {
  if (!(price > 0) || !Number.isFinite(tMs)) return;
  const t = Math.floor(tMs / 1000);
  const last = samples[samples.length - 1];
  if (last && last.t === t) {
    last.price = price;
    return;
  }
  if (last && t < last.t) return;
  samples.push({ t, price });
  const cutoff = t - KEEP_SEC;
  while (samples.length > 2 && (samples[0]?.t ?? 0) < cutoff) samples.shift();
}

function persist() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(samples.slice(-4000)));
  } catch {
    /* le disque n'est pas indispensable */
  }
}

function restore() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Sample[];
    if (!Array.isArray(parsed)) return;
    for (const row of parsed) {
      if (row && row.price > 0 && Number.isFinite(row.t)) samples.push({ t: row.t, price: row.price });
    }
  } catch {
    /* premier lancement */
  }
}

function connect() {
  const ws = new WebSocket("wss://ws-live-data.polymarket.com");
  socket = ws;
  let closing = false;
  let lastMessage = Date.now();
  // Signal de vie attendu par le serveur, et reconnexion si le flux se fige sans se fermer.
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    if (Date.now() - lastMessage > 30_000) shut();
  }, 5_000);
  const shut = () => {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    try {
      ws.close();
    } catch {
      /* déjà fermé */
    }
  };
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: JSON.stringify({ symbol: "btc/usd" }),
          },
        ],
      }),
    );
  };
  ws.onmessage = (event) => {
    lastMessage = Date.now();
    try {
      const text = String(event.data ?? "");
      if (!text.startsWith("{")) return;
      const message = JSON.parse(text) as {
        payload?: { value?: number; timestamp?: number; data?: { value?: number; timestamp?: number }[] };
      };
      const history = message.payload?.data;
      if (Array.isArray(history)) {
        for (const row of history) {
          if (row.timestamp != null && row.value != null) remember(row.timestamp, row.value);
        }
      } else if (message.payload?.timestamp != null && message.payload.value != null) {
        remember(message.payload.timestamp, message.payload.value);
      }
      if (samples.length > 0) resolveReady?.();
    } catch {
      /* un battement illisible */
    }
  };
  ws.onclose = () => {
    closing = true;
    clearInterval(heartbeat);
    if (socket === ws) {
      socket = null;
      setTimeout(connect, 1500);
    }
  };
  // Fermer depuis onerror redéclenche onerror : sans garde, la pile déborde et le serveur tombe.
  ws.onerror = () => shut();
}

export function ensureChainlink(): Promise<void> {
  if (!started) {
    started = true;
    restore();
    ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    if (samples.length > 0) resolveReady?.();
    connect();
    setInterval(persist, 15_000);
  }
  return Promise.race([
    ready ?? Promise.resolve(),
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ]);
}

export function chainlinkSamples(): Sample[] {
  return samples;
}

export function chainlinkPrice(): number | null {
  return samples[samples.length - 1]?.price ?? null;
}
