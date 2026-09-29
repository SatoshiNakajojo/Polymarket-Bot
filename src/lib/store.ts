import { create } from "zustand";
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
  entry?: string;
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
  entry?: string;
};

export type LiveFill = {
  id: string;
  windowStart: number;
  side: Side;
  ask: number;
  stake: number;
  openedAt: number;
  status: "accepted" | "rejected" | "retrying";
  orderId: string | null;
  detail: string;
  result?: "win" | "loss" | "stop";
  exitPrice?: number;
  btc?: number;
  entry?: string;
};

const STORAGE_KEY = "fenetre-desk-v1";
const LEGACY_KEY = "fenetre-paper-v1";

type SavedDesk = {
  cash: number;
  trades: PaperTrade[];
  open: OpenPosition | null;
  enteredWindow: number | null;
  armed: boolean;
  stakeUsd: number;
  minEdge: number;
  lossCap: number;
  entryWaitMin: number;
  earlyPct: number;
  invert: boolean;
  pair: boolean;
  btcStop: boolean;
  stopCents: number;
  mode: "paper" | "live";
  liveFills: LiveFill[];
};

function savedSlice(state: DeskState): SavedDesk {
  return {
    cash: state.cash,
    trades: state.trades,
    open: state.open,
    enteredWindow: state.enteredWindow,
    armed: state.armed,
    stakeUsd: state.stakeUsd,
    minEdge: state.minEdge,
    lossCap: state.lossCap,
    entryWaitMin: state.entryWaitMin,
    earlyPct: state.earlyPct,
    invert: state.invert,
    pair: state.pair,
    btcStop: state.btcStop,
    stopCents: state.stopCents,
    mode: state.mode,
    liveFills: state.liveFills,
  };
}

function parseSaved(raw: string | null): Partial<SavedDesk> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: Partial<SavedDesk> } & Partial<SavedDesk>;
    const state = parsed.state ?? parsed;
    if (!state || typeof state !== "object") return null;
    return state;
  } catch {
    return null;
  }
}

function readSaved(): Partial<SavedDesk> | null {
  if (typeof window === "undefined") return null;
  const current = parseSaved(localStorage.getItem(STORAGE_KEY));
  const legacy = parseSaved(localStorage.getItem(LEGACY_KEY));
  const count = (saved: Partial<SavedDesk> | null) => (saved?.trades?.length ?? 0) + (saved?.liveFills?.length ?? 0);
  if (count(current) >= count(legacy)) return current ?? legacy;
  return legacy ?? current;
}

function writeSaved(state: DeskState) {
  if (typeof window === "undefined" || !state.hydrated) return;
  try {
    const next = savedSlice(state);
    const nextCount = next.trades.length + next.liveFills.length;
    const existing = readSaved();
    const prevCount = (existing?.trades?.length ?? 0) + (existing?.liveFills?.length ?? 0);
    if (nextCount === 0 && prevCount > 0) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Le navigateur peut refuser le stockage. L'historique reste affiché. */
  }
}
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
  entryWaitMin: number;
  earlyPct: number;
  invert: boolean;
  pair: boolean;
  btcStop: boolean;
  stopCents: number;
  mode: "paper" | "live";
  liveFills: LiveFill[];
  setHydrated: () => void;
  setArmed: (armed: boolean) => void;
  setStakeUsd: (n: number) => void;
  setMinEdge: (n: number) => void;
  setLossCap: (n: number) => void;
  setEntryWaitMin: (n: number) => void;
  setEarlyPct: (n: number) => void;
  setInvert: (invert: boolean) => void;
  setPair: (pair: boolean) => void;
  setBtcStop: (btcStop: boolean) => void;
  setStopCents: (n: number) => void;
  setMode: (mode: "paper" | "live") => void;
  lockWindow: (windowStart: number) => void;
  pushLive: (fill: LiveFill) => void;
  upsertLive: (fill: LiveFill) => void;
  settleLive: (windowStart: number, outcome: Side) => void;
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
  entryWaitMin: 3,
  earlyPct: 75,
  invert: false,
  pair: false,
  btcStop: true,
  stopCents: 0,
  mode: "paper" as const,
  liveFills: [] as LiveFill[],
};

export const useDesk = create<DeskState>()((set, get) => ({
  hydrated: false,
  ...defaults,
  setHydrated: () => set({ hydrated: true }),
      setArmed: (armed) => set({ armed }),
      setStakeUsd: (stakeUsd) => set({ stakeUsd }),
      setMinEdge: (minEdge) => set({ minEdge }),
      setLossCap: (lossCap) => set({ lossCap }),
      setEntryWaitMin: (entryWaitMin) => set({ entryWaitMin }),
      setEarlyPct: (earlyPct) => set({ earlyPct }),
      setInvert: (invert) => set({ invert }),
      setPair: (pair) => set({ pair }),
      setBtcStop: (btcStop) => set({ btcStop }),
      setStopCents: (stopCents) => set({ stopCents }),
      setMode: (mode) => set({ mode }),
      lockWindow: (windowStart) => {
        if (get().enteredWindow === windowStart) return;
        set({ enteredWindow: windowStart });
      },
      pushLive: (fill) =>
        set((state) => ({ liveFills: [fill, ...state.liveFills].slice(0, 200) })),
      upsertLive: (fill) =>
        set((state) => ({
          liveFills: [fill, ...state.liveFills.filter((item) => item.id !== fill.id)].slice(0, 200),
        })),
      settleLive: (windowStart, outcome) =>
        set((state) => {
          let changed = false;
          const liveFills = state.liveFills.map((fill) => {
            if (fill.windowStart !== windowStart || fill.status !== "accepted" || fill.result) return fill;
            changed = true;
            const result: "win" | "loss" = fill.side === outcome ? "win" : "loss";
            return { ...fill, result };
          });
          return changed ? { liveFills } : state;
        }),
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
          trades: [trade, ...state.trades].slice(0, 200),
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
          trades: [trade, ...state.trades].slice(0, 200),
        });
      },
      reset: () =>
        set({
          cash: STARTING_CASH,
          open: null,
          enteredWindow: null,
        }),
    }),
);

if (typeof window !== "undefined") {
  useDesk.subscribe((state) => writeSaved(state));
}

function latestAt(rows: { openedAt?: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.openedAt ?? 0), 0);
}

function mergeById<T extends { id: string; openedAt: number }>(current: T[], older: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of older) map.set(item.id, item);
  for (const item of current) map.set(item.id, item);
  return [...map.values()].sort((a, b) => b.openedAt - a.openedAt).slice(0, 200);
}

export function currentSaved(): SavedDesk {
  return savedSlice(useDesk.getState());
}

export function adoptSaved(incoming: Partial<SavedDesk> | null) {
  if (!incoming) return;
  const state = useDesk.getState();
  const trades = mergeById(state.trades, Array.isArray(incoming.trades) ? incoming.trades : []);
  const liveFills = mergeById(state.liveFills, Array.isArray(incoming.liveFills) ? incoming.liveFills : []);
  const localCount = state.trades.length + state.liveFills.length;
  const fileCount = (incoming.trades?.length ?? 0) + (incoming.liveFills?.length ?? 0);
  const fileNewer = latestAt(incoming.trades ?? []) > latestAt(state.trades) || latestAt(incoming.liveFills ?? []) > latestAt(state.liveFills);
  const takeFile = fileCount > localCount || (fileNewer && fileCount > 0);
  useDesk.setState({
    trades,
    liveFills,
    cash: takeFile && typeof incoming.cash === "number" ? incoming.cash : state.cash,
    open: state.open ?? incoming.open ?? null,
    enteredWindow: state.enteredWindow ?? incoming.enteredWindow ?? null,
    armed: takeFile && typeof incoming.armed === "boolean" ? incoming.armed : state.armed,
    stakeUsd: takeFile && typeof incoming.stakeUsd === "number" ? incoming.stakeUsd : state.stakeUsd,
    minEdge: takeFile && typeof incoming.minEdge === "number" ? incoming.minEdge : state.minEdge,
    lossCap: takeFile && typeof incoming.lossCap === "number" ? incoming.lossCap : state.lossCap,
    entryWaitMin: takeFile && typeof incoming.entryWaitMin === "number" ? incoming.entryWaitMin : state.entryWaitMin,
    earlyPct: takeFile && typeof incoming.earlyPct === "number" ? incoming.earlyPct : state.earlyPct,
    invert: takeFile && typeof incoming.invert === "boolean" ? incoming.invert : state.invert,
    pair: typeof incoming.pair === "boolean" ? incoming.pair : state.pair,
    btcStop: typeof incoming.btcStop === "boolean" ? incoming.btcStop : state.btcStop,
    stopCents: typeof incoming.stopCents === "number" ? incoming.stopCents : state.stopCents,
    mode: takeFile && (incoming.mode === "live" || incoming.mode === "paper") ? incoming.mode : state.mode,
    hydrated: true,
  });
}

export function restoreDesk() {
  const saved = readSaved();
  if (saved) {
    useDesk.setState({
      cash: typeof saved.cash === "number" ? saved.cash : STARTING_CASH,
      trades: Array.isArray(saved.trades) ? saved.trades : [],
      open: saved.open ?? null,
      enteredWindow: saved.enteredWindow ?? null,
      armed: typeof saved.armed === "boolean" ? saved.armed : true,
      stakeUsd: typeof saved.stakeUsd === "number" ? saved.stakeUsd : 10,
      minEdge: typeof saved.minEdge === "number" ? saved.minEdge : 0.03,
      lossCap: typeof saved.lossCap === "number" ? saved.lossCap : 80,
      entryWaitMin: typeof saved.entryWaitMin === "number" ? saved.entryWaitMin : 3,
      earlyPct: typeof saved.earlyPct === "number" ? saved.earlyPct : 75,
      invert: typeof saved.invert === "boolean" ? saved.invert : false,
      pair: typeof saved.pair === "boolean" ? saved.pair : false,
      btcStop: typeof saved.btcStop === "boolean" ? saved.btcStop : true,
      stopCents: typeof saved.stopCents === "number" ? saved.stopCents : 0,
      mode: saved.mode === "live" ? "live" : "paper",
      liveFills: Array.isArray(saved.liveFills) ? saved.liveFills : [],
    });
  }
  useDesk.setState({ hydrated: true });
}
