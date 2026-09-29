const KEY = "fenetre-equity-v2";

export type EquitySource = "live" | "paper";
export type EquityPoint = { t: number; value: number; source: EquitySource };

const EMPTY: EquityPoint[] = [];
const listeners = new Set<() => void>();

function fromStorage(): EquityPoint[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as EquityPoint[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (point) =>
        point != null &&
        Number.isFinite(point.t) &&
        Number.isFinite(point.value) &&
        (point.source === "live" || point.source === "paper"),
    );
  } catch {
    return [];
  }
}

let all = fromStorage();
let liveSnap = all.filter((point) => point.source === "live");
let paperSnap = all.filter((point) => point.source === "paper");
let saveTimer = 0;

function persist(next: EquityPoint[], save: boolean) {
  all = next.slice(-500);
  liveSnap = all.filter((point) => point.source === "live");
  paperSnap = all.filter((point) => point.source === "paper");
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(all));
  for (const listener of listeners) listener();
  if (!save || typeof window === "undefined") return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void import("@/lib/history").then(({ saveEquity }) => saveEquity({ data: all }));
  }, 400);
}

export function subscribeEquity(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function equitySnapshot(source: EquitySource): EquityPoint[] {
  return source === "live" ? liveSnap : paperSnap;
}

export function adoptEquity(incoming: EquityPoint[]) {
  const map = new Map<string, EquityPoint>();
  for (const point of incoming) map.set(`${point.source}:${point.t}`, point);
  for (const point of all) map.set(`${point.source}:${point.t}`, point);
  persist([...map.values()].sort((a, b) => a.t - b.t), true);
}

export function noteEquity(value: number, source: EquitySource) {
  if (typeof window === "undefined" || !Number.isFinite(value)) return;
  const same = all.filter((point) => point.source === source);
  const last = same[same.length - 1];
  const now = Date.now();
  if (last && Math.abs(last.value - value) < 0.005 && now - last.t < 60_000) return;
  persist([...all, { t: now, value: Math.round(value * 100) / 100, source }], true);
}
