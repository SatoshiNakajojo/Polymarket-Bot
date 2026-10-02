/**
 * Lit ce que les programmes papier écrivent sur cette machine (journal,
 * suivi papier, teneur de marché) pour l'afficher dans la page.
 * Rien n'est écrit ici.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type {
  Lab,
  LabIa,
  LabIaHistory,
  LabMakerState,
  LabPaperLive,
  LabPaperScores,
  LabVariant,
  LabWindow,
} from "@/lib/lab-types";

const JOURNAL = process.env.JOURNAL_DIR ?? "data/journal";
const MAKER = process.env.MAKER_DIR ?? "data/maker";
const WINDOW = 300;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function mtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Dernières lignes complètes d'un fichier, sans le lire en entier. */
function tailLines(file: string, bytes = 96_000): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } finally {
    closeSync(fd);
  }
}

function parseLines<T>(lines: string[]): T[] {
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* ligne abîmée */
    }
  }
  return out;
}

type Outcome = {
  window: number;
  outcome: "Up" | "Down";
  strike: number | null;
  final: number | null;
  journal_outcome: string | null;
};
type MakerLine = {
  window: number;
  variante?: string;
  outcome?: "Up" | "Down";
  pnl: number;
  pairPnl: number;
  pairs: number;
  up: number;
  down: number;
  fills: number;
};

function observed(): { counts: Map<number, number>; lastAt: number | null; source: string | null } {
  const counts = new Map<number, number>();
  const lines = tailLines(`${JOURNAL}/observations.csv`);
  let lastAt: number | null = null;
  let source: string | null = null;
  for (const line of lines) {
    const cells = line.split(",");
    const ts = Number(cells[0]);
    const window = Number(cells[1]);
    if (!(window > 0) || !(ts > 0)) continue;
    counts.set(window, (counts.get(window) ?? 0) + 1);
    lastAt = ts * 1000;
    source = cells[5] ?? null;
  }
  return { counts, lastAt, source };
}

function variantStats(lines: MakerLine[], state: LabMakerState | null): LabVariant[] {
  const names = new Map((state?.variantes ?? []).map((v) => [v.cle, v.nom]));
  const keys = [...new Set([...names.keys(), ...lines.map((l) => l.variante ?? "base")])];
  return keys.map((key) => {
    const rows = lines
      .filter((l) => (l.variante ?? "base") === key)
      .sort((a, b) => a.window - b.window);
    const traded = rows.filter((r) => r.fills > 0);
    const n = traded.length;
    const total = traded.reduce((a, r) => a + r.pnl, 0);
    const mean = n ? total / n : 0;
    const se =
      n > 1 ? Math.sqrt(traded.reduce((a, r) => a + (r.pnl - mean) ** 2, 0) / (n - 1) / n) : null;
    let running = 0;
    const curve = rows.map((r) => {
      running += r.pnl;
      return { t: r.window * 1000, total: Math.round(running * 100) / 100 };
    });
    const step = Math.max(1, Math.ceil(curve.length / 300));
    return {
      cle: key,
      nom: names.get(key) ?? key,
      fenetres: rows.length,
      avecExecutions: n,
      total,
      paires: traded.reduce((a, r) => a + r.pairPnl, 0),
      moyenne: mean,
      incertitude: se == null ? null : 2 * se,
      courbe: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
    };
  });
}

export function loadLab(): Lab {
  const now = Date.now();
  const obs = observed();
  const outcomes = new Map(
    parseLines<Outcome>(tailLines(`${JOURNAL}/resultats.jsonl`, 200_000)).map((o) => [o.window, o]),
  );
  const makerLines = existsSync(`${MAKER}/resultats.jsonl`)
    ? parseLines<MakerLine>(
        readFileSync(`${MAKER}/resultats.jsonl`, "utf8")
          .split("\n")
          .filter((l) => l.trim()),
      )
    : [];
  const makerByWindow = new Map(
    makerLines.filter((l) => (l.variante ?? "base") === "base").map((l) => [l.window, l]),
  );
  const makerState = readJson<LabMakerState>(`${MAKER}/etat.json`);
  const paperLive = readJson<LabPaperLive>(`${JOURNAL}/papier-live.json`);
  const paperScores = readJson<LabPaperScores>(`${JOURNAL}/papier.json`);

  const current = Math.floor(now / 1000 / WINDOW) * WINDOW;
  const starts = new Set<number>([
    current,
    ...obs.counts.keys(),
    ...[...makerByWindow.keys()].slice(-12),
  ]);
  const fenetres: LabWindow[] = [...starts]
    .sort((a, b) => b - a)
    .slice(0, 12)
    .map((start) => {
      const o = outcomes.get(start) ?? null;
      const m = makerByWindow.get(start) ?? null;
      const live = now / 1000 < start + WINDOW;
      const outcome = o?.outcome ?? m?.outcome ?? null;
      return {
        start,
        statut: live ? "en cours" : outcome ? "réglée" : "en attente du règlement",
        resultat: outcome,
        prixABattre: o?.strike ?? null,
        prixFinal: o?.final ?? null,
        reconstitution: o?.journal_outcome ? o.journal_outcome === o.outcome : null,
        releves: obs.counts.get(start) ?? 0,
        maker: m
          ? { pnl: m.pnl, paires: m.pairs, up: m.up, down: m.down, executions: m.fills }
          : null,
      };
    });

  return {
    maintenant: now,
    services: {
      journal: { majA: obs.lastAt, source: obs.source },
      papier: { majA: mtime(`${JOURNAL}/papier-live.json`) },
      maker: { majA: mtime(`${MAKER}/etat.json`), flux: makerState?.flux ?? null },
      ia: { majA: mtime(`${JOURNAL}/ia.json`) },
    },
    fenetres,
    maker: { etat: makerState, variantes: variantStats(makerLines, makerState) },
    papier: { scores: paperScores, live: paperLive },
    ia: {
      dernier: readJson<LabIa>(`${JOURNAL}/ia.json`),
      historique: parseLines<LabIaHistory>(tailLines(`${JOURNAL}/ia-historique.jsonl`, 40_000)).slice(-60),
    },
  };
}
