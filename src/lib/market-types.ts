import type { Quote } from "@/lib/engine";

export type PricePoint = { t: number; price: number };

export type WindowView = {
  start: number;
  end: number;
  strike: number;
  twap: number;
  elapsed: number;
  remaining: number;
  complete: boolean;
  path: PricePoint[];
  /** Moyenne Chainlink déjà acquise dans la dernière minute (règlement TWAP 60 s), sinon null. */
  last60?: number | null;
};

export type Snapshot =
  | { ok: false; error: string; serverNow: number }
  | {
      ok: true;
      serverNow: number;
      price: number;
      sigmaPerSqrtSec: number;
      feeRate: number;
      minOrderSize: number;
      live: WindowView;
      previous: WindowView;
      settled: { start: number; outcome: "Up" | "Down" }[];
      market: null | {
        slug: string;
        title: string;
        acceptingOrders: boolean;
        upToken: string;
        downToken: string;
        up: Quote;
        down: Quote;
      };
    };
