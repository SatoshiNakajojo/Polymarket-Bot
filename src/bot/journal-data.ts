/** Lecture du journal (tous les fichiers observations*.csv) et des résultats officiels. */
import { existsSync, readdirSync, readFileSync } from "node:fs";

export type Row = {
  window: number;
  elapsed: number;
  remaining: number;
  spot: number | null;
  sigma: number | null;
  pModel: number;
  upBid: number | null;
  upAsk: number | null;
  upSize: number | null;
  downBid: number | null;
  downAsk: number | null;
  feeRate: number;
  upBidSize: number | null;
  upBidDepth: number | null;
  upAskDepth: number | null;
  ret15: number | null;
  ret60: number | null;
  ret300: number | null;
  up: 0 | 1;
};

export type Journal = { rows: Row[]; windows: number; resolved: number; agree: number; checked: number };

const num = (s: string | undefined) => (s == null || s === "" ? null : Number(s));

export function loadJournal(dir: string): Journal {
  const outFile = `${dir}/resultats.jsonl`;
  const obsFiles = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^observations.*\.csv$/.test(f))
        .sort()
        .map((f) => `${dir}/${f}`)
    : [];
  if (obsFiles.length === 0) {
    throw new Error(`Journal introuvable dans ${dir}/. Lance d'abord : npm run journal`);
  }
  if (!existsSync(outFile)) {
    throw new Error("Aucune fenêtre réglée pour l'instant. Laisse tourner le journal quelques minutes de plus.");
  }
  const outcomes = new Map<number, "Up" | "Down">();
  let agree = 0;
  let checked = 0;
  for (const line of readFileSync(outFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { window: number; outcome: "Up" | "Down"; journal_outcome: string | null };
      outcomes.set(r.window, r.outcome);
      if (r.journal_outcome) {
        checked += 1;
        if (r.journal_outcome === r.outcome) agree += 1;
      }
    } catch {
      /* ligne abîmée */
    }
  }
  const rows: Row[] = [];
  const seen = new Set<number>();
  for (const file of obsFiles) {
    const [head, ...lines] = readFileSync(file, "utf8").split("\n");
    const col = new Map(head.split(",").map((name, i) => [name, i]));
    for (const line of lines) {
      if (!line.trim()) continue;
      const c = line.split(",");
      const get = (name: string) => (col.has(name) ? c[col.get(name) as number] : undefined);
      const window = Number(get("window"));
      if (!(window > 0)) continue;
      seen.add(window);
      const outcome = outcomes.get(window);
      const pModel = num(get("p_model"));
      if (!outcome || pModel == null) continue;
      rows.push({
        window,
        elapsed: Number(get("elapsed")),
        remaining: Number(get("remaining")),
        spot: num(get("spot")),
        sigma: num(get("sigma")),
        pModel,
        upBid: num(get("up_bid")),
        upAsk: num(get("up_ask")),
        upSize: num(get("up_size")),
        downBid: num(get("down_bid")),
        downAsk: num(get("down_ask")),
        feeRate: Number(get("fee_rate")) || 0.07,
        upBidSize: num(get("up_bid_size")),
        upBidDepth: num(get("up_bid_depth")),
        upAskDepth: num(get("up_ask_depth")),
        ret15: num(get("ret15")),
        ret60: num(get("ret60")),
        ret300: num(get("ret300")),
        up: outcome === "Up" ? 1 : 0,
      });
    }
  }
  rows.sort((a, b) => a.window - b.window || a.elapsed - b.elapsed);
  return { rows, windows: seen.size, resolved: new Set(rows.map((r) => r.window)).size, agree, checked };
}

/** Milieu du carnet Up, si le carnet est lisible. */
export function marketP(r: Row): number | null {
  if (r.upBid == null || r.upAsk == null) return null;
  if (r.upAsk - r.upBid > 0.1) return null;
  return (r.upBid + r.upAsk) / 2;
}
