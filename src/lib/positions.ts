import { createServerFn } from "@tanstack/react-start";

export type HeldPosition = {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  currentValue: number;
  redeemable: boolean;
};

export const loadPositions = createServerFn({ method: "POST" })
  .validator((data: { wallet: string }) => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(data.wallet)) throw new Error("Adresse illisible.");
    return data;
  })
  .handler(async ({ data }): Promise<HeldPosition[]> => {
    const response = await fetch(
      `https://data-api.polymarket.com/positions?user=${data.wallet}&sizeThreshold=0`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) throw new Error("Liste des parts indisponible.");
    const rows = (await response.json()) as {
      conditionId?: string;
      title?: string;
      outcome?: string;
      size?: number;
      currentValue?: number;
      redeemable?: boolean;
    }[];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => (row.size ?? 0) > 0 && typeof row.conditionId === "string")
      .map((row) => ({
        conditionId: row.conditionId as string,
        title: row.title ?? "",
        outcome: row.outcome ?? "",
        size: row.size ?? 0,
        currentValue: row.currentValue ?? 0,
        redeemable: row.redeemable === true,
      }));
  });
