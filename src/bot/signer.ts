import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connectLive, placeLiveOrder, placeLiveSell } from "@/lib/live.ts";
import { builderFromEnv, readKey } from "./key.ts";
import { vetOrder, vetSell, type SpendState } from "./policy.ts";

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function send(res: ServerResponse, status: number, body: unknown) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(raw);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 4096) throw new Error("Requête trop grosse.");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

const token = process.env.SIGNER_TOKEN ?? "";
if (token.length < 16) throw new Error("SIGNER_TOKEN doit faire au moins 16 caractères.");

const maxStake = Number(process.env.FENETRE_STAKE ?? 10);
/** Volume maximum accepté sur 24 h glissantes. */
const lossCap = Number(process.env.FENETRE_CAP ?? 80);
const DAY = 24 * 3600;
const stateFile = process.env.SIGNER_STATE ?? "data/signer-etat.json";

type Ledger = { orders: { t: number; amount: number }[]; lastWindow: number | null; hedgedWindow: number | null };

/**
 * Le plafond compte le volume des 24 dernières heures, enregistré sur disque :
 * il ne se bloque plus pour de bon après quelques ordres, et un redémarrage ne
 * le remet pas à zéro.
 */
function loadLedger(): Ledger {
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<Ledger>;
    return {
      orders: Array.isArray(raw.orders) ? raw.orders.filter((o) => Number.isFinite(o.t) && Number.isFinite(o.amount)) : [],
      lastWindow: typeof raw.lastWindow === "number" ? raw.lastWindow : null,
      hedgedWindow: typeof raw.hedgedWindow === "number" ? raw.hedgedWindow : null,
    };
  } catch {
    return { orders: [], lastWindow: null, hedgedWindow: null };
  }
}

function saveLedger(ledger: Ledger) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(ledger));
}

const ledger = loadLedger();
const nowSec = () => Date.now() / 1000;
function spendState(): SpendState {
  const since = nowSec() - DAY;
  ledger.orders = ledger.orders.filter((o) => o.t >= since);
  return {
    spent: ledger.orders.reduce((sum, o) => sum + o.amount, 0),
    lastWindow: ledger.lastWindow,
    hedgedWindow: ledger.hedgedWindow,
  };
}

/** Jetons Up et Down du marché annoncé, lus chez Polymarket (on refuse si on ne peut pas vérifier). */
const tokenCache = new Map<string, Set<string>>();
async function marketTokens(slug: string): Promise<Set<string> | null> {
  const cached = tokenCache.get(slug);
  if (cached) return cached;
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const events = (await res.json()) as { markets?: { clobTokenIds?: unknown }[] }[];
    const raw = events[0]?.markets?.[0]?.clobTokenIds;
    const ids = Array.isArray(raw) ? raw : typeof raw === "string" ? (JSON.parse(raw) as unknown[]) : [];
    if (ids.length === 0) return null;
    const set = new Set(ids.map(String));
    tokenCache.set(slug, set);
    if (tokenCache.size > 50) tokenCache.delete(tokenCache.keys().next().value as string);
    return set;
  } catch {
    return null;
  }
}

const session = await connectLive(readKey(), process.env.POLY_FUNDER ?? "", builderFromEnv());
const host = process.env.SIGNER_HOST ?? "127.0.0.1";
const port = Number(process.env.SIGNER_PORT ?? 8787);

const server = createServer(async (req, res) => {
  try {
    if (!sameSecret(bearer(req), token)) {
      send(res, 401, { ok: false, message: "Jeton refusé." });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, { ok: true, wallet: session.wallet, spent24h: spendState().spent, cap24h: lossCap });
      return;
    }
    if (req.method === "POST" && req.url === "/order") {
      const verdict = vetOrder(await readBody(req), { maxStake, lossCap }, spendState(), nowSec());
      if (!verdict.ok) {
        send(res, 400, verdict);
        return;
      }
      const tokens = await marketTokens(verdict.order.slug);
      if (!tokens?.has(verdict.order.assetId)) {
        send(res, 400, { ok: false, message: "Ce jeton n'appartient pas au marché annoncé (ou Polymarket est injoignable)." });
        return;
      }
      const placed = await placeLiveOrder({
        tokenId: verdict.order.assetId,
        amount: verdict.order.amount,
        maxPrice: verdict.order.maxPrice,
      });
      if (placed.ok) {
        if (verdict.order.hedge) ledger.hedgedWindow = verdict.order.windowStart;
        else ledger.lastWindow = verdict.order.windowStart;
        ledger.orders.push({ t: nowSec(), amount: placed.filledUsd > 0 ? placed.filledUsd : verdict.order.amount });
        saveLedger(ledger);
      }
      console.log(
        placed.ok
          ? `envoyé ${verdict.order.slug} ${verdict.order.amount}$ ${placed.orderId}`
          : `refusé ${verdict.order.slug} ${placed.message}`,
      );
      send(res, placed.ok ? 200 : 422, placed);
      return;
    }
    if (req.method === "POST" && req.url === "/sell") {
      const verdict = vetSell(await readBody(req), nowSec());
      if (!verdict.ok) {
        send(res, 400, verdict);
        return;
      }
      const tokens = await marketTokens(verdict.sell.slug);
      if (!tokens?.has(verdict.sell.assetId)) {
        send(res, 400, { ok: false, message: "Ce jeton n'appartient pas au marché annoncé (ou Polymarket est injoignable)." });
        return;
      }
      const placed = await placeLiveSell({
        tokenId: verdict.sell.assetId,
        shares: verdict.sell.shares,
        minPrice: verdict.sell.minPrice,
      });
      console.log(placed.ok ? `vendu ${verdict.sell.slug} ${placed.orderId}` : `vente refusée ${placed.message}`);
      send(res, placed.ok ? 200 : 422, placed);
      return;
    }
    send(res, 404, { ok: false, message: "Route inconnue." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur signer.";
    console.error(message);
    send(res, 500, { ok: false, message });
  }
});

server.listen(port, host, () => {
  const localOnly = host === "127.0.0.1" || host === "localhost";
  console.log(
    localOnly
      ? `Signer ${session.wallet} sur ${host}:${port}. Joignable seulement ici. Pour le VPS, SIGNER_HOST = adresse Tailscale du Pi.`
      : `Signer ${session.wallet} sur ${host}:${port}. La clé ne quitte pas cette machine.`,
  );
  console.log(`Plafond : ${maxStake}$ par ordre, ${lossCap}$ de volume sur 24 h glissantes (déjà ${spendState().spent.toFixed(2)}$).`);
  if (host === "0.0.0.0" || host === "::") {
    console.warn("Ouvert sur toutes les interfaces. Réserve ça à Tailscale, jamais à Internet.");
  }
});
