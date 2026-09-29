export type OrderRequest = {
  assetId: string;
  amount: number;
  maxPrice: number;
  windowStart: number;
  slug: string;
  hedge: boolean;
};

export type SellRequest = {
  assetId: string;
  shares: number;
  minPrice: number;
  windowStart: number;
  slug: string;
};

export type SpendState = {
  spent: number;
  lastWindow: number | null;
  hedgedWindow?: number | null;
};

/** Fenêtre en cours à l'instant `nowSec` : on refuse le passé et le futur lointain. */
function staleWindow(windowStart: number, nowSec: number | undefined): boolean {
  if (nowSec == null) return false;
  return windowStart < nowSec - 300 - 5 || windowStart > nowSec + 60;
}

export function vetOrder(
  body: unknown,
  limits: { maxStake: number; lossCap: number },
  state: SpendState,
  nowSec?: number,
): { ok: true; order: OrderRequest } | { ok: false; message: string } {
  if (body == null || typeof body !== "object") return { ok: false, message: "Corps d'ordre illisible." };
  const raw = body as Record<string, unknown>;
  const assetId = typeof raw.assetId === "string" ? raw.assetId.trim() : "";
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  const amount = Number(raw.amount);
  const maxPrice = Number(raw.maxPrice);
  const windowStart = Number(raw.windowStart);

  if (!/^\d{8,}$/.test(assetId) && !/^0x[0-9a-fA-F]{16,}$/.test(assetId)) {
    return { ok: false, message: "Identifiant de contrat refusé." };
  }
  const slugMatch = /^btc-updown-5m-(\d+)$/.exec(slug);
  if (!slugMatch) return { ok: false, message: "Seul le marché BTC 5 min est autorisé." };
  const hedge = raw.hedge === true;
  if (!Number.isFinite(windowStart) || slugMatch[1] !== String(windowStart)) {
    return { ok: false, message: "La fenêtre ne correspond pas au marché." };
  }
  if (staleWindow(windowStart, nowSec)) return { ok: false, message: "Ce n'est pas la fenêtre en cours." };
  const ceiling = hedge ? limits.lossCap : limits.maxStake;
  if (!Number.isFinite(amount) || amount < 1 || amount > ceiling) {
    return { ok: false, message: `Mise hors plafond (1 à ${ceiling} $).` };
  }
  if (!Number.isFinite(maxPrice) || maxPrice < 0.01 || maxPrice > 0.99) {
    return { ok: false, message: "Prix limite hors 1 c – 99 c." };
  }
  if (hedge) {
    if (state.lastWindow !== windowStart) return { ok: false, message: "Couverture sans position ouverte." };
    if (state.hedgedWindow === windowStart) return { ok: false, message: "Couverture déjà faite sur cette fenêtre." };
  } else if (state.lastWindow === windowStart) {
    return { ok: false, message: "Déjà un ordre sur cette fenêtre." };
  }
  if (state.spent + amount > limits.lossCap + 1e-9) {
    return { ok: false, message: "Plafond de session atteint." };
  }
  return { ok: true, order: { assetId, amount, maxPrice, windowStart, slug, hedge } };
}

export function vetSell(body: unknown, nowSec?: number): { ok: true; sell: SellRequest } | { ok: false; message: string } {
  if (body == null || typeof body !== "object") return { ok: false, message: "Corps d'ordre illisible." };
  const raw = body as Record<string, unknown>;
  const assetId = typeof raw.assetId === "string" ? raw.assetId.trim() : "";
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  const shares = Number(raw.shares);
  const minPrice = Number(raw.minPrice);
  const windowStart = Number(raw.windowStart);
  if (!/^\d{8,}$/.test(assetId) && !/^0x[0-9a-fA-F]{16,}$/.test(assetId)) {
    return { ok: false, message: "Identifiant de contrat refusé." };
  }
  const slugMatch = /^btc-updown-5m-(\d+)$/.exec(slug);
  if (!slugMatch) return { ok: false, message: "Seul le marché BTC 5 min est autorisé." };
  if (!Number.isFinite(windowStart) || slugMatch[1] !== String(windowStart)) {
    return { ok: false, message: "La fenêtre ne correspond pas au marché." };
  }
  if (staleWindow(windowStart, nowSec)) return { ok: false, message: "Ce n'est pas la fenêtre en cours." };
  if (!Number.isFinite(shares) || shares < 0.1 || shares > 500) {
    return { ok: false, message: "Nombre de parts hors limite." };
  }
  if (!Number.isFinite(minPrice) || minPrice < 0.01 || minPrice > 0.99) {
    return { ok: false, message: "Prix de vente hors 1 c – 99 c." };
  }
  return { ok: true, sell: { assetId, shares, minPrice, windowStart, slug } };
}
