import { createServerFn } from "@tanstack/react-start";

export type HistoryFile = {
  cash: number;
  trades: { id: string; openedAt: number }[];
  liveFills: { id: string; openedAt: number }[];
  open: Record<string, string | number | boolean | null> | null;
  enteredWindow: number | null;
  armed: boolean;
  stakeUsd: number;
  minEdge: number;
  lossCap: number;
  entryWaitMin: number;
  earlyPct: number;
  invert: boolean;
  mode: "paper" | "live";
};

export const readHistory = createServerFn({ method: "POST" }).handler(async (): Promise<HistoryFile | null> => {
  const { loadHistory } = await import("./history.server");
  return loadHistory() as HistoryFile | null;
});

export const saveHistory = createServerFn({ method: "POST" })
  .validator((data: HistoryFile) => data)
  .handler(async ({ data }) => {
    const { storeHistory } = await import("./history.server");
    return storeHistory(data);
  });

export type StoredEquityPoint = { t: number; value: number; source: "live" | "paper" };

export const readEquity = createServerFn({ method: "POST" }).handler(async (): Promise<StoredEquityPoint[]> => {
  const { loadEquity } = await import("./history.server");
  return loadEquity();
});

export const saveEquity = createServerFn({ method: "POST" })
  .validator((data: StoredEquityPoint[]) => data)
  .handler(async ({ data }) => {
    const { storeEquity } = await import("./history.server");
    return storeEquity(data);
  });
