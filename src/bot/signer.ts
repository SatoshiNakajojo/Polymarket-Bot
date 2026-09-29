import { timingSafeEqual } from "node:crypto";
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
const lossCap = Number(process.env.FENETRE_CAP ?? 80);
const state: SpendState = { spent: 0, lastWindow: null, hedgedWindow: null };

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
      send(res, 200, { ok: true, wallet: session.wallet, spent: state.spent });
      return;
    }
    if (req.method === "POST" && req.url === "/order") {
      const verdict = vetOrder(await readBody(req), { maxStake, lossCap }, state);
      if (!verdict.ok) {
        send(res, 400, verdict);
        return;
      }
      const placed = await placeLiveOrder({
        tokenId: verdict.order.assetId,
        amount: verdict.order.amount,
        maxPrice: verdict.order.maxPrice,
      });
      if (placed.ok) {
        if (verdict.order.hedge) state.hedgedWindow = verdict.order.windowStart;
        else state.lastWindow = verdict.order.windowStart;
        state.spent += verdict.order.amount;
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
      const verdict = vetSell(await readBody(req));
      if (!verdict.ok) {
        send(res, 400, verdict);
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
  if (host === "0.0.0.0" || host === "::") {
    console.warn("Ouvert sur toutes les interfaces. Réserve ça à Tailscale, jamais à Internet.");
  }
});
