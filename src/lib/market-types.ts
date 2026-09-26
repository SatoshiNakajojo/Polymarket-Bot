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
      market: null | {
        slug: string;
        title: string;
        acceptingOrders: boolean;
        up: Quote;
        down: Quote;
      };
    };
