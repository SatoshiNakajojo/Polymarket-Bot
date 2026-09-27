export type OrderRequest = {
  assetId: string;
  amount: number;
  maxPrice: number;
  windowStart: number;
  slug: string;
};

export type SpendState = {
  spent: number;
  lastWindow: number | null;
};

export function vetOrder(
  body: unknown,
  limits: { maxStake: number; lossCap: number },
  state: SpendState,
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
  if (!Number.isFinite(windowStart) || slugMatch[1] !== String(windowStart)) {
    return { ok: false, message: "La fenêtre ne correspond pas au marché." };
  }
  if (!Number.isFinite(amount) || amount < 1 || amount > limits.maxStake) {
    return { ok: false, message: `Mise hors plafond (1 à ${limits.maxStake} $).` };
  }
  if (!Number.isFinite(maxPrice) || maxPrice < 0.01 || maxPrice > 0.99) {
    return { ok: false, message: "Prix limite hors 1 c – 99 c." };
  }
  if (state.lastWindow === windowStart) return { ok: false, message: "Déjà un ordre sur cette fenêtre." };
  if (state.spent + amount > limits.lossCap + 1e-9) {
    return { ok: false, message: "Plafond de session atteint." };
  }
  return { ok: true, order: { assetId, amount, maxPrice, windowStart, slug } };
}
