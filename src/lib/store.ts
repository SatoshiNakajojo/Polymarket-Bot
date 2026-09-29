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
  exit?: "stop";
  hedged?: boolean;
  hedge?: { side: Side; ask: number; shares: number; cost: number; fee: number } | null;
  plan?: "direct" | "inverse" | "stop" | "double";
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
  btc?: number;
  hedge?: { side: Side; ask: number; shares: number; cost: number; fee: number } | null;
  plan?: "direct" | "inverse" | "stop" | "double";
};

export const PAPER_PLANS = ["direct", "inverse", "stop", "double"] as const;
export type PaperPlan = (typeof PAPER_PLANS)[number];

export type PaperBook = {
  cash: number;
  trades: PaperTrade[];
  open: OpenPosition | null;
  enteredWindow: number | null;
};

export type PaperBooks = Record<PaperPlan, PaperBook>;

export function paperLabel(plan: PaperPlan): string {
  if (plan === "direct") return "Normal";
  if (plan === "inverse") return "Inversé";
  if (plan === "stop") return "Stop BTC";
  return "Double";
}

export function blankBook(): PaperBook {
  return { cash: STARTING_CASH, trades: [], open: null, enteredWindow: null };
}

export function blankBooks(): PaperBooks {
  return { direct: blankBook(), inverse: blankBook(), stop: blankBook(), double: blankBook() };
}

export function bookCash(book: PaperBook): number {
  const pnl = book.trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const locked = book.open ? book.open.cost + (book.open.hedge?.cost ?? 0) : 0;
  return STARTING_CASH + pnl - locked;
}

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
  plan?: PaperPlan;
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
  books: PaperBooks;
  paperOn: Record<PaperPlan, boolean>;
  livePlan: PaperPlan;
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
    books: state.books,
    paperOn: state.paperOn,
    livePlan: state.livePlan,
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
    const existing = readSaved();
    const books = mergeBooks(state.books, existing?.books ?? null);
    const direct = books.direct;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...savedSlice(state),
        books,
        trades: mergeById(direct.trades, Array.isArray(existing?.trades) ? existing.trades : []),
        liveFills: mergeById(state.liveFills, Array.isArray(existing?.liveFills) ? existing.liveFills : []),
      }),
    );
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
  books: PaperBooks;
  paperOn: Record<PaperPlan, boolean>;
  livePlan: PaperPlan;
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
  setPaperOn: (plan: PaperPlan, on: boolean) => void;
  setLivePlan: (plan: PaperPlan) => void;
  lockWindow: (windowStart: number) => void;
  pushLive: (fill: LiveFill) => void;
  upsertLive: (fill: LiveFill) => void;
  settleLive: (windowStart: number, outcome: Side) => void;
  enter: (position: OpenPosition) => void;
  settle: (windowStart: number, outcome: Side, twap: number) => void;
  voidOpen: (windowStart: number) => void;
  enterBook: (plan: PaperPlan, position: OpenPosition) => void;
  settleBook: (plan: PaperPlan, windowStart: number, outcome: Side, twap: number) => void;
  voidBook: (plan: PaperPlan, windowStart: number) => void;
  stopBook: (plan: PaperPlan, bid: number) => void;
  hedgeBook: (plan: PaperPlan, hedge: NonNullable<OpenPosition["hedge"]>) => void;
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
  books: blankBooks(),
  paperOn: { direct: true, inverse: true, stop: true, double: true },
  livePlan: "direct" as PaperPlan,
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
      setPair: (pair) => set(pair ? { pair: true, btcStop: false } : { pair: false }),
      setBtcStop: (btcStop) => set(btcStop ? { btcStop: true, pair: false } : { btcStop: false }),
      setStopCents: (stopCents) => set({ stopCents }),
      setMode: (mode) => set({ mode }),
      setPaperOn: (plan, on) => set((state) => ({ paperOn: { ...state.paperOn, [plan]: on } })),
      setLivePlan: (livePlan) => set({ livePlan }),
      lockWindow: (windowStart) => {
        if (get().enteredWindow === windowStart) return;
        set({ enteredWindow: windowStart });
      },
      pushLive: (fill) =>
        set((state) => ({ liveFills: [fill, ...state.liveFills].slice(0, 200) })),
      upsertLive: (fill) =>
        set((state) => {
          const prev = state.liveFills.find((item) => item.id === fill.id);
          const fromEntry = planFromEntry(fill.entry ?? prev?.entry);
          const plan = fill.plan ?? prev?.plan ?? (fromEntry === "direct" ? state.livePlan : fromEntry);
          return {
            liveFills: [{ ...fill, plan }, ...state.liveFills.filter((item) => item.id !== fill.id)].slice(0, 200),
          };
        }),
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
        get().enterBook("direct", position);
      },
      settle: (windowStart, outcome, twap) => {
        get().settleBook("direct", windowStart, outcome, twap);
      },
      voidOpen: (windowStart) => {
        get().voidBook("direct", windowStart);
      },
      enterBook: (plan, position) => {
        const state = get();
        const book = state.books[plan];
        if (book.open || book.enteredWindow === position.windowStart) return;
        if (position.cost > book.cash) return;
        const stamped = { ...position, plan };
        set(
          mirror(state, plan, {
            ...book,
            open: stamped,
            enteredWindow: position.windowStart,
            cash: book.cash - position.cost,
          }),
        );
      },
      settleBook: (plan, windowStart, outcome, twap) => {
        const state = get();
        const book = state.books[plan];
        const open = book.open;
        if (!open || open.windowStart !== windowStart) return;
        const payout =
          (open.side === outcome ? open.shares : 0) +
          (open.hedge && open.hedge.side === outcome ? open.hedge.shares : 0);
        const spent = open.cost + (open.hedge?.cost ?? 0);
        const trade: PaperTrade = {
          ...open,
          status: payout > spent ? "win" : "loss",
          pnl: payout - spent,
          outcome,
          settleTwap: twap,
          hedged: open.hedge != null,
        };
        set(
          mirror(state, plan, {
            cash: book.cash + payout,
            open: null,
            enteredWindow: book.enteredWindow,
            trades: [trade, ...book.trades].slice(0, 200),
          }),
        );
      },
      voidBook: (plan, windowStart) => {
        const state = get();
        const book = state.books[plan];
        const open = book.open;
        if (!open || open.windowStart !== windowStart) return;
        const spent = open.cost + (open.hedge?.cost ?? 0);
        const trade: PaperTrade = {
          ...open,
          status: "void",
          pnl: 0,
          outcome: null,
          settleTwap: null,
          hedged: open.hedge != null,
        };
        set(
          mirror(state, plan, {
            cash: book.cash + spent,
            open: null,
            enteredWindow: book.enteredWindow,
            trades: [trade, ...book.trades].slice(0, 200),
          }),
        );
      },
      stopBook: (plan, bid) => {
        const state = get();
        const book = state.books[plan];
        const open = book.open;
        if (!open || open.hedge) return;
        const payout = open.shares * bid;
        const trade: PaperTrade = {
          ...open,
          status: payout >= open.cost ? "win" : "loss",
          pnl: payout - open.cost,
          outcome: null,
          settleTwap: null,
          exit: "stop",
        };
        set(
          mirror(state, plan, {
            cash: book.cash + payout,
            open: null,
            enteredWindow: book.enteredWindow,
            trades: [trade, ...book.trades].slice(0, 200),
          }),
        );
      },
      hedgeBook: (plan, hedge) => {
        const state = get();
        const book = state.books[plan];
        const open = book.open;
        if (!open || open.hedge || hedge.cost > book.cash) return;
        set(mirror(state, plan, { ...book, cash: book.cash - hedge.cost, open: { ...open, hedge } }));
      },
      reset: () => {
        const state = get();
        const books = blankBooks();
        for (const plan of PAPER_PLANS) {
          const kept = { ...state.books[plan], open: null, enteredWindow: null };
          kept.cash = bookCash(kept);
          books[plan] = kept;
        }
        set({
          books,
          cash: books.direct.cash,
          trades: books.direct.trades,
          open: null,
          enteredWindow: null,
        });
      },
    }),
);

if (typeof window !== "undefined") {
  useDesk.subscribe((state) => writeSaved(state));
}

function asPlan(value: unknown): PaperPlan | null {
  return value === "direct" || value === "inverse" || value === "stop" || value === "double" ? value : null;
}

function mirror(state: DeskState, plan: PaperPlan, book: PaperBook) {
  const books = { ...state.books, [plan]: book };
  const direct = books.direct;
  return {
    books,
    cash: direct.cash,
    trades: direct.trades,
    open: direct.open,
    enteredWindow: direct.enteredWindow,
  };
}

function planFromEntry(entry?: string): PaperPlan {
  const text = entry?.toLowerCase() ?? "";
  if (text.includes("invers")) return "inverse";
  if (text.includes("double") || text.includes("paire")) return "double";
  if (/(?:^|·|\s)stop(?:$|·|\s)/.test(text)) return "stop";
  return "direct";
}

function strategyTag(plan: PaperPlan): string {
  if (plan === "inverse") return "inversé";
  if (plan === "stop") return "stop";
  if (plan === "double") return "double";
  return "normal";
}

function cleanEntry(entry: string | undefined, plan: PaperPlan): string {
  let base = entry ?? "";
  for (let i = 0; i < 3; i++) {
    const next = base.replace(/\s*·\s*(inversé|inverse|normal|direct|stop|double|paire)\s*$/i, "");
    if (next === base) break;
    base = next;
  }
  base = base.trim();
  const tag = strategyTag(plan);
  return base ? `${base} · ${tag}` : tag;
}

function planFromId(id: string): PaperPlan | null {
  if (id.includes("-stop-")) return "stop";
  if (id.includes("-double-")) return "double";
  if (id.includes("-inverse-")) return "inverse";
  if (id.includes("-direct-")) return "direct";
  return null;
}

function homeOf(
  trade: { id?: string; entry?: string; plan?: PaperPlan | null; exit?: "stop"; hedge?: unknown; hedged?: boolean },
  foundIn: PaperPlan,
): PaperPlan {
  if (trade.exit === "stop") return "stop";
  const fromId = trade.id ? planFromId(trade.id) : null;
  if (fromId) return fromId;
  if (trade.hedge || trade.hedged) return "double";
  const explicit = asPlan(trade.plan);
  if (explicit) return explicit;
  const fromEntry = planFromEntry(trade.entry);
  if (fromEntry !== "direct") return fromEntry;
  return foundIn;
}

function rebucket(books: PaperBooks): PaperBooks {
  const next = blankBooks();
  const seen = new Set<string>();
  for (const plan of PAPER_PLANS) {
    next[plan].enteredWindow = books[plan]?.enteredWindow ?? null;
    for (const trade of books[plan]?.trades ?? []) {
      if (seen.has(trade.id)) continue;
      seen.add(trade.id);
      const home = homeOf(trade, plan);
      next[home].trades.push({ ...trade, plan: home, entry: cleanEntry(trade.entry, home) });
    }
  }
  for (const plan of PAPER_PLANS) {
    const open = books[plan]?.open;
    if (!open) continue;
    const home = homeOf(open, plan);
    const current = next[home].open;
    if (current && current.openedAt >= open.openedAt) continue;
    next[home].open = { ...open, plan: home, entry: cleanEntry(open.entry, home) };
    next[home].enteredWindow = open.windowStart;
  }
  for (const plan of PAPER_PLANS) {
    next[plan].trades.sort((a, b) => b.openedAt - a.openedAt);
    next[plan].cash = bookCash(next[plan]);
  }
  return next;
}

function booksFromLegacy(trades: PaperTrade[], open: OpenPosition | null): PaperBooks {
  const books = blankBooks();
  for (const trade of trades) {
    const plan = planFromEntry(trade.entry);
    books[plan].trades.push(trade);
  }
  for (const plan of PAPER_PLANS) {
    books[plan].trades.sort((a, b) => b.openedAt - a.openedAt);
    books[plan].cash = bookCash(books[plan]);
  }
  if (open) {
    const plan = planFromEntry(open.entry);
    books[plan].open = open;
    books[plan].enteredWindow = open.windowStart;
    books[plan].cash = bookCash(books[plan]);
  }
  return rebucket(books);
}

function mergeBooks(current: PaperBooks | null | undefined, older: PaperBooks | null | undefined): PaperBooks {
  const books = blankBooks();
  for (const plan of PAPER_PLANS) {
    const a = current?.[plan];
    const b = older?.[plan];
    const trades = mergeById(a?.trades ?? [], b?.trades ?? []);
    const open = a?.open ?? b?.open ?? null;
    const enteredWindow = a?.enteredWindow ?? b?.enteredWindow ?? null;
    books[plan] = { trades, open, enteredWindow, cash: 0 };
    books[plan].cash = bookCash(books[plan]);
  }
  return rebucket(books);
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
  const incomingBooks =
    incoming.books ??
    booksFromLegacy(Array.isArray(incoming.trades) ? incoming.trades : [], incoming.open ?? null);
  const books = mergeBooks(state.books, incomingBooks);
  const direct = books.direct;
  const liveFills = mergeById(state.liveFills, Array.isArray(incoming.liveFills) ? incoming.liveFills : []);
  const localCount = PAPER_PLANS.reduce((sum, plan) => sum + state.books[plan].trades.length, 0) + state.liveFills.length;
  const fileCount =
    PAPER_PLANS.reduce((sum, plan) => sum + (incomingBooks[plan]?.trades.length ?? 0), 0) +
    (incoming.liveFills?.length ?? 0);
  const fileNewer =
    latestAt(incomingBooks.direct.trades) > latestAt(state.books.direct.trades) ||
    latestAt(incoming.liveFills ?? []) > latestAt(state.liveFills);
  const takeFile = fileCount > localCount || (fileNewer && fileCount > 0);
  const paperOn = { ...state.paperOn };
  for (const plan of PAPER_PLANS) {
    const flag = incoming.paperOn?.[plan];
    if (typeof flag === "boolean") paperOn[plan] = flag;
  }
  useDesk.setState({
    books,
    paperOn,
    trades: direct.trades,
    liveFills,
    cash: direct.cash,
    open: direct.open,
    enteredWindow: direct.enteredWindow,
    armed: takeFile && typeof incoming.armed === "boolean" ? incoming.armed : state.armed,
    stakeUsd: takeFile && typeof incoming.stakeUsd === "number" ? incoming.stakeUsd : state.stakeUsd,
    minEdge: takeFile && typeof incoming.minEdge === "number" ? incoming.minEdge : state.minEdge,
    lossCap: takeFile && typeof incoming.lossCap === "number" ? incoming.lossCap : state.lossCap,
    entryWaitMin: takeFile && typeof incoming.entryWaitMin === "number" ? incoming.entryWaitMin : state.entryWaitMin,
    earlyPct: takeFile && typeof incoming.earlyPct === "number" ? incoming.earlyPct : state.earlyPct,
    invert: takeFile && typeof incoming.invert === "boolean" ? incoming.invert : state.invert,
    pair: typeof incoming.pair === "boolean" ? incoming.pair : state.pair,
    btcStop:
      (typeof incoming.pair === "boolean" ? incoming.pair : state.pair)
        ? false
        : typeof incoming.btcStop === "boolean"
          ? incoming.btcStop
          : state.btcStop,
    stopCents: typeof incoming.stopCents === "number" ? incoming.stopCents : state.stopCents,
    mode: takeFile && (incoming.mode === "live" || incoming.mode === "paper") ? incoming.mode : state.mode,
    livePlan: asPlan(incoming.livePlan) ?? state.livePlan,
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
      btcStop: saved.pair === true ? false : typeof saved.btcStop === "boolean" ? saved.btcStop : true,
      stopCents: typeof saved.stopCents === "number" ? saved.stopCents : 0,
      mode: saved.mode === "live" ? "live" : "paper",
      liveFills: Array.isArray(saved.liveFills) ? saved.liveFills : [],
      books:
        saved.books != null
          ? mergeBooks(saved.books, null)
          : booksFromLegacy(Array.isArray(saved.trades) ? saved.trades : [], saved.open ?? null),
      paperOn: {
        direct: saved.paperOn?.direct !== false,
        inverse: saved.paperOn?.inverse !== false,
        stop: saved.paperOn?.stop !== false,
        double: saved.paperOn?.double !== false,
      },
      livePlan: asPlan(saved.livePlan) ?? (saved.invert ? "inverse" : saved.pair ? "double" : "direct"),
    });
    const direct = useDesk.getState().books.direct;
    useDesk.setState({ cash: direct.cash, trades: direct.trades, open: direct.open, enteredWindow: direct.enteredWindow });
  }
  useDesk.setState({ hydrated: true });
}
