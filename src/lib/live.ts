import { createPublicClient, formatUnits, http, isAddress } from "viem";
import { polygon } from "viem/chains";

const erc20Balance = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const RPCS = ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"];

export type WalletBalances = {
  pusd: number;
  usdc: number;
};

export async function readWalletBalances(address: string): Promise<WalletBalances> {
  if (!isAddress(address)) throw new Error("Adresse illisible.");
  let last: unknown;
  for (const url of RPCS) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(url) });
      const account = address as `0x${string}`;
      const [pusd, usdc, usdce] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: PUSD, abi: erc20Balance, functionName: "balanceOf", args: [account] },
          { address: USDC, abi: erc20Balance, functionName: "balanceOf", args: [account] },
          { address: USDC_E, abi: erc20Balance, functionName: "balanceOf", args: [account] },
        ],
      });
      return {
        pusd: Number(formatUnits(pusd, 6)),
        usdc: Number(formatUnits(usdc, 6)) + Number(formatUnits(usdce, 6)),
      };
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("Solde Polygon indisponible.");
}

export type LiveSession = {
  wallet: string;
  signer: string;
};

type PlaceResult =
  | { ok: true; orderId: string; status: string; filledUsd: number }
  | { ok: false; message: string };

type Handle = LiveSession & {
  place: (order: { tokenId: string; amount: number; maxPrice: number }) => Promise<PlaceResult>;
  sell: (order: { tokenId: string; shares: number; minPrice: number }) => Promise<{ ok: true; orderId: string; status: string } | { ok: false; message: string }>;
  returnCash: () => Promise<string>;
  redeem: () => Promise<string>;
  close: () => Promise<void>;
};

let handle: Handle | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeLive(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLiveSession(): LiveSession | null {
  return handle;
}

function builderAuthorization(creds: { key: string; secret: string; passphrase: string }) {
  return {
    isBuilderKey: true,
    supportGasless: true,
    async authorize(request: { method: string; path: string; body?: string }) {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await signBuilder(creds.secret.trim(), timestamp, request.method, request.path, request.body);
      return {
        POLY_BUILDER_API_KEY: creds.key.trim(),
        POLY_BUILDER_PASSPHRASE: creds.passphrase.trim(),
        POLY_BUILDER_SIGNATURE: signature,
        POLY_BUILDER_TIMESTAMP: `${timestamp}`,
      };
    },
  };
}

function decodeBuilderSecret(secret: string): ArrayBuffer {
  const padded = secret.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

async function signBuilder(secret: string, timestamp: number, method: string, path: string, body?: string) {
  const payload = `${timestamp}${method}${path}${body ?? ""}`;
  const key = await crypto.subtle.importKey("raw", decodeBuilderSecret(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  let text = "";
  for (const byte of new Uint8Array(signed)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizeKey(raw: string): string {
  const key = raw.trim();
  const body = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error("Clé invalide. Il faut 64 caractères hexadécimaux, avec ou sans 0x.");
  }
  return `0x${body}`;
}

export async function connectLive(
  rawKey: string,
  funder: string,
  builder?: { key: string; secret: string; passphrase: string },
): Promise<LiveSession> {
  if (handle) await disconnectLive();
  const { createSecureClient, OrderSide, OrderType } = await import("@polymarket/client");
  const { privateKey } = await import("@polymarket/client/viem");
  const creds = builder?.key.trim() && builder.secret.trim() && builder.passphrase.trim() ? builder : null;
  const wallet = funder.trim();
  const client = await createSecureClient({
    signer: privateKey(normalizeKey(rawKey)),
    ...(creds ? { apiKey: builderAuthorization(creds) } : wallet ? { wallet } : {}),
  });
  handle = {
    wallet: client.account.wallet,
    signer: client.account.signer,
    async returnCash() {
      const account = client.account.wallet as `0x${string}`;
      const destination = client.account.signer;
      if (account.toLowerCase() === destination.toLowerCase()) {
        throw new Error("Ces fonds sont déjà sur l'adresse MetaMask.");
      }
      const publicClient = createPublicClient({ chain: polygon, transport: http(RPCS[0]) });
      const tokens = [
        { address: USDC, label: "USDC" },
        { address: USDC_E, label: "USDC.e" },
        { address: PUSD, label: "pUSD" },
      ] as const;
      const balances = await publicClient.multicall({
        allowFailure: false,
        contracts: tokens.map((token) => ({
          address: token.address,
          abi: erc20Balance,
          functionName: "balanceOf" as const,
          args: [account],
        })),
      });
      const sent: string[] = [];
      for (let i = 0; i < tokens.length; i += 1) {
        const amount = balances[i];
        if (amount <= 0n) continue;
        const tx = await client.transferErc20({
          amount,
          recipientAddress: destination,
          tokenAddress: tokens[i].address,
        });
        await tx.wait();
        sent.push(`${tokens[i].label} ${formatUnits(amount, 6)}`);
      }
      if (sent.length === 0) throw new Error("Rien à renvoyer.");
      return `Renvoyé vers ${destination} : ${sent.join(", ")}.`;
    },
    async redeem() {
      const { loadPositions } = await import("@/lib/snapshot");
      const rows = await loadPositions({ data: { wallet: client.account.wallet } });
      const targets = [
        ...new Map(
          rows
            .filter((row) => row.redeemable && row.currentValue > 0.01)
            .map((row) => [row.conditionId, row]),
        ).values(),
      ];
      if (targets.length === 0) {
        const open = rows.filter((row) => row.size > 0 && !row.redeemable);
        if (open.length === 0) return "Aucune part gagnante à convertir. Le solde du haut est seulement le pUSD libre.";
        return open
          .map((row) => `${row.outcome} · ${row.size.toFixed(1)} parts · ${row.currentValue.toFixed(2)} $ · pas encore réglé`)
          .join("\n");
      }
      try {
        await client.setupTradingApprovals();
      } catch {
        /* déjà autorisé, ou l'autorisation est incluse dans la conversion */
      }
      let done = 0;
      const errors: string[] = [];
      for (const row of targets) {
        try {
          const tx = await client.redeemPositions({ conditionId: row.conditionId });
          await Promise.race([
            tx.wait(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Toujours en cours. Regarde le solde dans une minute.")), 25_000),
            ),
          ]);
          done += 1;
        } catch (error) {
          const text = error instanceof Error ? error.message : "rejet";
          if (text.includes("Relayer API Key") || text.includes("Builder API Key")) {
            throw new Error("Reconnecte avec la clé builder, puis réessaie.");
          }
          errors.push(`${row.outcome} ${row.currentValue.toFixed(2)} $ : ${text}`);
        }
      }
      if (done === 0) throw new Error(errors[0] ?? "Polymarket a refusé la conversion.");
      return `Gains récupérés sur ${done} marché${done > 1 ? "s" : ""}. Le pUSD libre va remonter.`;
    },
    async place(order) {
      const book = await client.fetchOrderBook({ assetId: order.tokenId });
      const tick = Number(book.tickSize) > 0 ? Number(book.tickSize) : 0.01;
      const cap = Math.min(0.99, order.maxPrice);
      const levels = book.asks
        .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
        .filter((level) => level.price > 0 && level.price <= cap + 1e-9 && level.size > 0)
        .sort((a, b) => a.price - b.price);
      let shares = 0;
      let worst = 0;
      let notional = 0;
      for (const level of levels) {
        const room = Math.max(0, order.amount - notional);
        const take = Math.min(level.size, room / level.price);
        if (!(take > 0)) break;
        shares += take;
        notional += take * level.price;
        worst = level.price;
        if (notional >= order.amount - 0.01) break;
      }
      if (!(shares >= Number(book.minOrderSize) || shares >= 5) || !(notional >= 1)) {
        return { ok: false, message: "Personne ne vend à ce prix." };
      }
      const maxPrice = Math.min(0.99, Math.round(Math.ceil(worst / tick - 1e-9) * tick * 1000) / 1000);
      const response = await client.placeMarketOrder({
        assetId: order.tokenId,
        side: OrderSide.BUY,
        amount: Math.min(order.amount, Math.floor(notional * 100) / 100),
        maxPrice,
        orderType: OrderType.FAK,
      });
      if (!response.ok) return { ok: false, message: response.message };
      const filledUsd = Number(response.makingAmount);
      return {
        ok: true,
        orderId: response.orderId,
        status: String(response.status),
        filledUsd: filledUsd > 0 ? filledUsd : order.amount,
      };
    },
    async sell(order: { tokenId: string; shares: number; minPrice: number }) {
      const book = await client.fetchOrderBook({ assetId: order.tokenId });
      const shares = Math.floor(order.shares * 100) / 100;
      if (!(shares >= Number(book.minOrderSize) || shares >= 5)) {
        return { ok: false, message: "Trop peu de parts à revendre." };
      }
      const response = await client.placeMarketOrder({
        assetId: order.tokenId,
        side: OrderSide.SELL,
        shares,
        minPrice: Math.max(0.01, order.minPrice),
        orderType: OrderType.FAK,
      });
      if (!response.ok) return { ok: false, message: response.message };
      return { ok: true, orderId: response.orderId, status: String(response.status) };
    },
    close: () => client.endAuthentication().then(() => undefined),
  };
  emit();
  return handle;
}

export async function disconnectLive() {
  const current = handle;
  handle = null;
  emit();
  if (current) await current.close().catch(() => undefined);
}

export async function depositBridgeAddress(wallet: string): Promise<string> {
  if (!isAddress(wallet)) throw new Error("Adresse du bot illisible.");
  const response = await fetch("https://bridge.polymarket.com/deposit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet }),
  });
  if (!response.ok) throw new Error("Pont Polymarket indisponible.");
  const body = (await response.json()) as { address?: { evm?: string } };
  const evm = body.address?.evm;
  if (!evm || !isAddress(evm)) throw new Error("Adresse de dépôt absente.");
  return evm;
}

export function redeemWinnings() {
  if (!handle) throw new Error("Compte réel déconnecté.");
  return handle.redeem();
}

export function returnCashToMetaMask() {
  if (!handle) throw new Error("Compte réel déconnecté.");
  return handle.returnCash();
}

export function placeLiveOrder(order: { tokenId: string; amount: number; maxPrice: number }) {
  if (!handle) throw new Error("Compte réel déconnecté.");
  return handle.place(order);
}

export function placeLiveSell(order: { tokenId: string; shares: number; minPrice: number }) {
  if (!handle) throw new Error("Compte réel déconnecté.");
  return handle.sell(order);
}
