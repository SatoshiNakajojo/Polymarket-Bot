import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Side } from "@/lib/engine";

export const STARTING_CASH = 1000;

export type PaperTrade = {
  id: string;
  windowStart: number;
  side: Side;
  ask: number;
  shares: number;
  cost: number;
  fee: number;
  pModel: number;
  ev: number;
  openedAt: number;
  status: "win" | "loss" | "void";
  pnl: number;
  outcome: Side | null;
  settleTwap: number | null;
  strike: number;
};

export type OpenPosition = {
  id: string;
  windowStart: number;
  side: Side;
  ask: number;
  shares: number;
  cost: number;
  fee: number;
  pModel: number;
  ev: number;
  openedAt: number;
  strike: number;
};

type DeskState = {
  hydrated: boolean;
  cash: number;
  trades: PaperTrade[];
  open: OpenPosition | null;
  enteredWindow: number | null;
  armed: boolean;
  stakeUsd: number;
  minEdge: number;
  lossCap: number;
  setHydrated: () => void;
  setArmed: (armed: boolean) => void;
  setStakeUsd: (n: number) => void;
  setMinEdge: (n: number) => void;
  setLossCap: (n: number) => void;
  enter: (position: OpenPosition) => void;
  settle: (windowStart: number, outcome: Side, twap: number) => void;
  voidOpen: (windowStart: number) => void;
  reset: () => void;
};

const defaults = {
  cash: STARTING_CASH,
  trades: [] as PaperTrade[],
  open: null as OpenPosition | null,
  enteredWindow: null as number | null,
  armed: true,
  stakeUsd: 10,
  minEdge: 0.03,
  lossCap: 80,
};

export const useDesk = create<DeskState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      ...defaults,
      setHydrated: () => set({ hydrated: true }),
      setArmed: (armed) => set({ armed }),
      setStakeUsd: (stakeUsd) => set({ stakeUsd }),
      setMinEdge: (minEdge) => set({ minEdge }),
      setLossCap: (lossCap) => set({ lossCap }),
      enter: (position) => {
        const state = get();
        if (state.open || state.enteredWindow === position.windowStart) return;
        if (position.cost > state.cash) return;
        set({
          open: position,
          enteredWindow: position.windowStart,
          cash: state.cash - position.cost,
        });
      },
      settle: (windowStart, outcome, twap) => {
        const state = get();
        const open = state.open;
        if (!open || open.windowStart !== windowStart) return;
        const win = open.side === outcome;
        const payout = win ? open.shares : 0;
        const pnl = payout - open.cost;
        const trade: PaperTrade = {
          ...open,
          status: win ? "win" : "loss",
          pnl,
          outcome,
          settleTwap: twap,
        };
        set({
          open: null,
          cash: state.cash + payout,
          trades: [trade, ...state.trades].slice(0, 40),
        });
      },
      voidOpen: (windowStart) => {
        const state = get();
        const open = state.open;
        if (!open || open.windowStart !== windowStart) return;
        const trade: PaperTrade = {
          ...open,
          status: "void",
          pnl: 0,
          outcome: null,
          settleTwap: null,
        };
        set({
          open: null,
          cash: state.cash + open.cost,
          trades: [trade, ...state.trades].slice(0, 40),
        });
      },
      reset: () =>
        set({
          ...defaults,
          armed: get().armed,
          stakeUsd: get().stakeUsd,
          minEdge: get().minEdge,
          lossCap: get().lossCap,
        }),
    }),
    {
      name: "fenetre-paper-v1",
      skipHydration: true,
      partialize: (state) => ({
        cash: state.cash,
        trades: state.trades,
        open: state.open,
        enteredWindow: state.enteredWindow,
        armed: state.armed,
        stakeUsd: state.stakeUsd,
        minEdge: state.minEdge,
        lossCap: state.lossCap,
      }),
    },
  ),
);
