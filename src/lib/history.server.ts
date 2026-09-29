import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FILE = "data/fenetre-history.json";

export type HistoryFile = {
  cash: number;
  trades: { id: string; openedAt: number }[];
  liveFills: { id: string; openedAt: number }[];
  open: unknown;
  enteredWindow: number | null;
  armed: boolean;
  stakeUsd: number;
  minEdge: number;
  lossCap: number;
  entryWaitMin: number;
  earlyPct: number;
  invert: boolean;
  mode: "paper" | "live";
  books?: unknown;
  paperOn?: unknown;
};

function asList(value: unknown): { id: string; openedAt: number }[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is { id: string; openedAt: number } =>
      row != null && typeof row === "object" && typeof (row as { id?: unknown }).id === "string",
  );
}

export function normalizeHistory(raw: unknown): HistoryFile | null {
  if (raw == null || typeof raw !== "object") return null;
  const row = raw as Partial<HistoryFile>;
  const trades = asList(row.trades);
  const liveFills = asList(row.liveFills);
  return {
    cash: typeof row.cash === "number" ? row.cash : 1000,
    trades,
    liveFills,
    open: row.open ?? null,
    enteredWindow: typeof row.enteredWindow === "number" ? row.enteredWindow : null,
    armed: row.armed !== false,
    stakeUsd: typeof row.stakeUsd === "number" ? row.stakeUsd : 10,
    minEdge: typeof row.minEdge === "number" ? row.minEdge : 0.03,
    lossCap: typeof row.lossCap === "number" ? row.lossCap : 80,
    entryWaitMin: typeof row.entryWaitMin === "number" ? row.entryWaitMin : 3,
    earlyPct: typeof row.earlyPct === "number" ? row.earlyPct : 75,
    invert: row.invert === true,
    mode: row.mode === "live" ? "live" : "paper",
    books: row.books && typeof row.books === "object" ? row.books : undefined,
    paperOn: row.paperOn && typeof row.paperOn === "object" ? row.paperOn : undefined,
  };
}

function mergeById<T extends { id: string; openedAt: number }>(current: T[], older: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of older) map.set(item.id, item);
  for (const item of current) map.set(item.id, item);
  return [...map.values()].sort((a, b) => b.openedAt - a.openedAt).slice(0, 200);
}

const PAPER_PLAN_IDS = ["direct", "inverse", "stop", "double", "inverseStop", "flip"] as const;

function countHistory(file: HistoryFile): number {
  const books = file.books as Record<string, { trades?: unknown[] }> | undefined;
  const bookCount = books
    ? PAPER_PLAN_IDS.reduce(
        (sum, plan) => sum + (Array.isArray(books[plan]?.trades) ? books[plan].trades.length : 0),
        0,
      )
    : 0;
  return bookCount + file.trades.length + file.liveFills.length;
}

function mergeHistoryBooks(current: unknown, older: unknown): unknown {
  if (current == null && older == null) return undefined;
  const left = (current ?? {}) as Record<string, { trades?: { id: string; openedAt: number }[]; open?: unknown; enteredWindow?: number | null; cash?: number }>;
  const right = (older ?? {}) as typeof left;
  const out: Record<string, unknown> = {};
  for (const plan of PAPER_PLAN_IDS) {
    const a = left[plan];
    const b = right[plan];
    if (!a && !b) continue;
    out[plan] = {
      trades: mergeById(a?.trades ?? [], b?.trades ?? []),
      open: a?.open ?? b?.open ?? null,
      enteredWindow: a?.enteredWindow ?? b?.enteredWindow ?? null,
      cash: typeof a?.cash === "number" ? a.cash : b?.cash,
    };
  }
  return out;
}

export function loadHistory(): HistoryFile | null {
  try {
    return normalizeHistory(JSON.parse(readFileSync(FILE, "utf8")));
  } catch {
    return null;
  }
}

export function storeHistory(raw: unknown): { ok: boolean } {
  const next = normalizeHistory(raw);
  if (!next) return { ok: false };
  const prev = loadHistory();
  const nextCount = countHistory(next);
  const prevCount = prev ? countHistory(prev) : 0;
  if (nextCount === 0 && prevCount > 0) return { ok: false };
  const merged: HistoryFile = {
    ...next,
    trades: mergeById(next.trades, prev?.trades ?? []),
    liveFills: mergeById(next.liveFills, prev?.liveFills ?? []),
    books: mergeHistoryBooks(next.books, prev?.books),
    paperOn: next.paperOn ?? prev?.paperOn,
  };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(merged));
  return { ok: true };
}

const EQUITY_FILE = "data/fenetre-equity.json";

type EquityPoint = { t: number; value: number; source: "live" | "paper" };

function asPoints(raw: unknown): EquityPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (point): point is EquityPoint =>
      point != null &&
      typeof point === "object" &&
      Number.isFinite((point as EquityPoint).t) &&
      Number.isFinite((point as EquityPoint).value) &&
      ((point as EquityPoint).source === "live" || (point as EquityPoint).source === "paper"),
  );
}

export function loadEquity(): EquityPoint[] {
  try {
    return asPoints(JSON.parse(readFileSync(EQUITY_FILE, "utf8")));
  } catch {
    return [];
  }
}

export function storeEquity(raw: unknown): { ok: boolean } {
  const next = asPoints(raw);
  const prev = loadEquity();
  if (next.length === 0 && prev.length > 0) return { ok: false };
  const map = new Map<string, EquityPoint>();
  for (const point of prev) map.set(`${point.source}:${point.t}`, point);
  for (const point of next) map.set(`${point.source}:${point.t}`, point);
  const merged = [...map.values()].sort((a, b) => a.t - b.t).slice(-500);
  mkdirSync(dirname(EQUITY_FILE), { recursive: true });
  writeFileSync(EQUITY_FILE, JSON.stringify(merged));
  return { ok: true };
}
