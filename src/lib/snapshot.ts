import { createServerFn } from "@tanstack/react-start";
import type { Snapshot } from "@/lib/market-types";

export type { Snapshot } from "@/lib/market-types";

export const getMarketSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<Snapshot> => {
    const { loadSnapshot } = await import("./market-data.server");
    return loadSnapshot();
  },
);
