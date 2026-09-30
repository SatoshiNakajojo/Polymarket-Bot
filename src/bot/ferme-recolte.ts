/**
 * Une récolte de la ferme de stratégies — sans lecture ni écriture de fichier.
 *
 * 1. Les fenêtres du journal sont coupées dans le temps : les premières
 *    (entraînement) servent à faire pousser et à choisir ; les dernières
 *    (épreuve) restent SCELLÉES jusqu'au jugement final.
 * 2. Semis : les stratégies déjà testées du bureau, plus des variantes.
 * 3. Générations : on garde les meilleures sur l'entraînement, on les fait
 *    muter et se croiser. La note est prudente : le gain moyen MOINS son
 *    incertitude, au pire des deux vitesses d'exécution.
 * 4. Jugement : les finalistes jouent les fenêtres scellées, à l'exécution
 *    lente (15 s de retard, pessimiste). Chacune est comparée à elle-même
 *    jouée à pile ou face — mêmes instants, côté tiré au sort — sur des
 *    milliers de tirages. Puis Benjamini-Hochberg corrige pour le nombre de
 *    finalistes : sur 20 essais sans aucun talent, un « gagne » par chance.
 *
 * Même doctrine que le Trading Desk (desk/, baselines/) : un résultat qui ne
 * bat pas le hasard n'est pas un résultat, et un test qui ne pouvait pas voir
 * le dit.
 */
import {
  cleGenome,
  croiser,
  estValide,
  famille,
  IDEES,
  joueur,
  libelle,
  muter,
  SEMENCES,
  hasard,
  type Genome,
} from "./ferme-familles.ts";
import type { Exec, WindowRows } from "./strategies.ts";

export type Reglages = {
  population: number;
  generations: number;
  finalistes: number;
  tirages: number;
  partEntrainement: number;
  alpha: number;
  graine: number;
  /** Trades minimum sur l'entraînement pour être noté. */
  minTrades: number;
  /** Trades minimum sur l'épreuve pour être promu. */
  minTradesEpreuve: number;
};

export const REGLAGES: Reglages = {
  population: 120,
  generations: 20,
  finalistes: 10,
  tirages: 2000,
  partEntrainement: 0.6,
  alpha: 0.05,
  graine: 1,
  minTrades: 30,
  minTradesEpreuve: 30,
};

export type Bilan = { trades: number; moyenne: number; incertitude: number; total: number; reussite: number; baisseMax: number; pire: number };

type Individu = { genome: Genome; cle: string; parent: string | null; origine: "semence" | "idée" | "mutation" | "croisement"; semence?: string };

/** Le bilan d'un joueur sur des fenêtres ; `pnls` = le gain de chaque trade. */
export function bilan(pnls: number[]): Bilan {
  const n = pnls.length;
  const moyenne = n ? pnls.reduce((a, b) => a + b, 0) / n : 0;
  const incertitude = n > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - moyenne) ** 2, 0) / (n - 1) / n) : Number.POSITIVE_INFINITY;
  let equite = 0, sommet = 0, baisse = 0;
  for (const p of pnls) {
    equite += p;
    sommet = Math.max(sommet, equite);
    baisse = Math.max(baisse, sommet - equite);
  }
  return {
    trades: n, moyenne, incertitude, total: pnls.reduce((a, b) => a + b, 0),
    reussite: n ? pnls.filter((p) => p > 0).length / n : 0,
    baisseMax: baisse, pire: n ? Math.min(...pnls) : 0,
  };
}

function gains(g: Genome, fenetres: WindowRows[], exec: Exec): number[] {
  const j = joueur(g);
  const out: number[] = [];
  for (const w of fenetres) {
    const r = j(w, exec, false);
    if (r) out.push(r.pnl);
  }
  return out;
}

/** Benjamini-Hochberg (montée) : garde les k plus petits p tels que p(k) ≤ α·k/m. */
export function benjaminiHochberg(ps: number[], alpha: number): boolean[] {
  const m = ps.length;
  const ordre = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  let k = 0;
  ordre.forEach(([p], r) => {
    if (p <= (alpha * (r + 1)) / m) k = r + 1;
  });
  const garde = new Array<boolean>(m).fill(false);
  for (let r = 0; r < k; r++) garde[ordre[r][1]] = true;
  return garde;
}

/**
 * Le modèle nul d'un finaliste : pour chaque fenêtre où il a joué, son gain
 * (a) et celui du côté opposé au même instant (b). Chaque tirage choisit a ou
 * b à pile ou face ; p = part des tirages qui font au moins aussi bien.
 */
export function pileOuFace(g: Genome, fenetres: WindowRows[], exec: Exec, tirages: number, rnd: () => number) {
  const j = joueur(g);
  const a: number[] = [], b: number[] = [];
  for (const w of fenetres) {
    const r = j(w, exec, false);
    if (!r) continue;
    a.push(r.pnl);
    b.push(j(w, exec, true)?.pnl ?? 0); // côté opposé injouable : pas de trade, 0
  }
  const n = a.length;
  if (!n) return { p: 1, moyenneHasard: 0, n };
  const observe = a.reduce((s, x) => s + x, 0) / n;
  let auMoins = 0, somme = 0;
  for (let t = 0; t < tirages; t++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rnd() < 0.5 ? a[i] : b[i];
    const m = s / n;
    somme += m;
    if (m >= observe - 1e-12) auMoins += 1;
  }
  return { p: (auMoins + 1) / (tirages + 1), moyenneHasard: somme / tirages, n };
}

export function recolter(toutes: WindowRows[], reglages: Partial<Reglages> = {}) {
  const R = { ...REGLAGES, ...reglages };
  const rnd = hasard(R.graine);
  const coupe = Math.floor(toutes.length * R.partEntrainement);
  const entrainement = toutes.slice(0, coupe);
  const epreuve = toutes.slice(coupe);

  const notes = new Map<string, { note: number; instant: Bilan; lent: Bilan }>();
  const noter = (ind: Individu) => {
    const vu = notes.get(ind.cle);
    if (vu) return vu;
    const instant = bilan(gains(ind.genome, entrainement, "instant"));
    const lent = bilan(gains(ind.genome, entrainement, "lent"));
    const prudente = (b: Bilan) => (b.trades >= R.minTrades ? b.moyenne - b.incertitude : Number.NEGATIVE_INFINITY);
    const r = { note: Math.min(prudente(instant), prudente(lent)), instant, lent };
    notes.set(ind.cle, r);
    return r;
  };

  // Semis : les stratégies testées, les idées neuves, et une variante de chacune.
  const semis: Individu[] = [
    ...SEMENCES.map((s) => ({ genome: s.genome, cle: cleGenome(s.genome), parent: null, origine: "semence" as const, semence: s.cle })),
    ...IDEES.map((g) => ({ genome: g, cle: cleGenome(g), parent: null, origine: "idée" as const })),
  ];
  const semences = semis.map((ind) => {
    const n = noter(ind);
    return { cle: ind.semence ?? null, famille: ind.genome.famille, libelle: libelle(ind.genome), origine: ind.origine, note: n.note, entrainement: n.lent };
  });
  let population = [...semis];
  const connu = new Set(population.map((i) => i.cle));
  const ajouter = (ind: Individu) => {
    if (connu.has(ind.cle) || !estValide(ind.genome)) return false;
    connu.add(ind.cle);
    population.push(ind);
    return true;
  };
  for (const s of semis) {
    const g = muter(s.genome, rnd);
    ajouter({ genome: g, cle: cleGenome(g), parent: s.cle, origine: "mutation" });
  }

  const journalGen: { generation: number; meilleure: number | null; mediane: number | null; evaluees: number }[] = [];
  for (let gen = 1; gen <= R.generations; gen++) {
    population.forEach(noter);
    population.sort((x, y) => noter(y).note - noter(x).note);
    const valables = population.map((i) => noter(i).note).filter(Number.isFinite);
    journalGen.push({
      generation: gen,
      meilleure: valables.length ? valables[0] : null,
      mediane: valables.length ? valables[Math.floor(valables.length / 2)] : null,
      evaluees: notes.size,
    });
    if (gen === R.generations) break;
    // Les élites restent ; le reste de la place va à leurs enfants.
    const elites = population.slice(0, Math.max(4, Math.ceil(R.population * 0.3)));
    population = [...elites];
    const tirer = () => elites[Math.floor(rnd() ** 1.5 * elites.length)]; // les premières plus souvent
    for (let essai = 0; population.length < R.population && essai < R.population * 20; essai++) {
      const pere = tirer();
      if (rnd() < 0.3) {
        const meres = elites.filter((e) => e.genome.famille === pere.genome.famille && e !== pere);
        if (meres.length) {
          const g = croiser(pere.genome, meres[Math.floor(rnd() * meres.length)].genome, rnd);
          ajouter({ genome: g, cle: cleGenome(g), parent: pere.cle, origine: "croisement" });
          continue;
        }
      }
      const g = muter(pere.genome, rnd);
      ajouter({ genome: g, cle: cleGenome(g), parent: pere.cle, origine: "mutation" });
    }
  }

  // Les finalistes : les mieux notées, rentables sur l'entraînement, au plus
  // trois par famille pour que la récolte ne soit pas dix fois la même idée.
  const parFamille = new Map<string, number>();
  const tous = [...new Map([...population, ...semis].map((i) => [i.cle, i])).values()]
    .filter((i) => Number.isFinite(noter(i).note) && noter(i).lent.moyenne > 0)
    .sort((x, y) => noter(y).note - noter(x).note);
  // Deux variantes qui font exactement les mêmes trades (un réglage qui ne
  // joue pas, par exemple) ne comptent que pour une.
  const comportements = new Set<string>();
  const finalistes: Individu[] = [];
  for (const i of tous) {
    const k = parFamille.get(i.genome.famille) ?? 0;
    if (k >= 3) continue;
    const n = noter(i);
    const trace = `${n.lent.trades}:${n.lent.total.toFixed(6)}:${n.instant.trades}:${n.instant.total.toFixed(6)}`;
    if (comportements.has(trace)) continue;
    comportements.add(trace);
    parFamille.set(i.genome.famille, k + 1);
    finalistes.push(i);
    if (finalistes.length >= R.finalistes) break;
  }

  // Le jugement, sur les fenêtres scellées.
  const juges = finalistes.map((i) => {
    const lent = bilan(gains(i.genome, epreuve, "lent"));
    const instant = bilan(gains(i.genome, epreuve, "instant"));
    const nul = pileOuFace(i.genome, epreuve, "lent", R.tirages, rnd);
    return { i, lent, instant, nul };
  });
  const garde = benjaminiHochberg(juges.map((j) => j.nul.p), R.alpha);
  const m = juges.length;
  const plancher = 1 / (R.tirages + 1);
  const minimum = m ? Math.ceil((plancher * m) / R.alpha) : 0;
  const criblage = {
    testees: m,
    bruts: juges.filter((j) => j.nul.p < R.alpha).length,
    attendues: Math.round(R.alpha * m * 10) / 10,
    survivants: garde.filter(Boolean).length,
    plancher,
    aveugle: plancher > R.alpha,
    resolution: !m
      ? "Aucune variante n'a été rentable sur l'entraînement : rien à juger."
      : plancher > R.alpha
        ? `${R.tirages} tirages : aucun finaliste ne pouvait survivre, quelle que soit la donnée.`
        : minimum > 1
          ? `${R.tirages} tirages : il faudrait ${minimum} finalistes au plancher pour qu'un seul survive.`
          : `${R.tirages} tirages pour ${m} finalistes : un finaliste isolé peut survivre. Le verdict porte sur la donnée.`,
  };

  const sortie = juges.map((j, k) => {
    const survit = garde[k];
    const promue = survit && j.lent.moyenne > 0 && j.lent.trades >= R.minTradesEpreuve;
    return {
      id: j.i.cle,
      famille: j.i.genome.famille,
      titreFamille: famille(j.i.genome.famille)?.titre ?? j.i.genome.famille,
      libelle: libelle(j.i.genome),
      genome: j.i.genome,
      origine: j.i.origine,
      semence: j.i.semence ?? null,
      parent: j.i.parent,
      note: noter(j.i).note,
      entrainement: noter(j.i).lent,
      epreuve: j.lent,
      epreuveInstant: j.instant,
      p: j.nul.p,
      moyenneHasard: j.nul.moyenneHasard,
      survit,
      promue,
      raison: promue
        ? "bat le hasard sur des fenêtres jamais vues, après correction"
        : survit
          ? j.lent.trades < R.minTradesEpreuve ? "trop peu de trades sur l'épreuve" : "bat le hasard mais perd de l'argent"
          : j.lent.moyenne <= 0 ? "perd sur les fenêtres jamais vues" : "gagne, mais pas mieux que pile ou face",
    };
  });

  const promues = sortie.filter((s) => s.promue);
  return {
    reglages: R,
    fenetres: {
      total: toutes.length,
      entrainement: { n: entrainement.length, de: entrainement[0]?.window ?? null, a: entrainement.at(-1)?.window ?? null },
      epreuve: { n: epreuve.length, de: epreuve[0]?.window ?? null, a: epreuve.at(-1)?.window ?? null },
    },
    semences,
    generations: journalGen,
    evaluees: notes.size,
    finalistes: sortie,
    criblage,
    promues: promues.map((s) => ({ id: s.id, libelle: s.libelle, genome: s.genome })),
    verdict: promues.length
      ? `${promues.length} stratégie${promues.length > 1 ? "s" : ""} promue${promues.length > 1 ? "s" : ""} au suivi papier.`
      : m
        ? "Aucune variante ne bat le hasard sur les fenêtres jamais vues. Rien n'est promu : c'est la ferme qui fait son travail."
        : "Rien de rentable à juger pour l'instant.",
  };
}

export type Recolte = ReturnType<typeof recolter>;
