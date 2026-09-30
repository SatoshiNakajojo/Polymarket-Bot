import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { cleGenome, croiser, estValide, FAMILLES, hasard, joueur, muter, SEMENCES } from "./ferme-familles.ts";
import { benjaminiHochberg, recolter } from "./ferme-recolte.ts";
import { loadJournal } from "./journal-data.ts";
import { groupWindows, strategies, summarize, type WindowRows } from "./strategies.ts";

const JOURNAL = "data/journal";
const fenetres = (): WindowRows[] => groupWindows(loadJournal(JOURNAL).rows);

test("chaque semence rejoue EXACTEMENT la stratégie testée dont elle vient", { skip: !existsSync(JOURNAL) }, () => {
  const w = fenetres();
  const origine = new Map(strategies().map((s) => [s.key, s]));
  for (const { cle, genome } of SEMENCES) {
    const s = origine.get(cle);
    assert.ok(s, `stratégie ${cle} introuvable`);
    const j = joueur(genome);
    for (const exec of ["instant", "lent"] as const) {
      const attendu = summarize(w, s, exec);
      const obtenu = summarize(w, { key: cle, label: cle, run: (x, e) => j(x, e, false) }, exec);
      assert.equal(obtenu.trades, attendu.trades, `${cle} ${exec} : trades`);
      assert.ok(Math.abs(obtenu.total - attendu.total) < 1e-9, `${cle} ${exec} : ${obtenu.total} ≠ ${attendu.total}`);
    }
  }
});

test("les semences sont valides et toutes les familles sont semées ou pensées", () => {
  for (const { cle, genome } of SEMENCES) assert.ok(estValide(genome), cle);
  const semees = new Set(SEMENCES.map((s) => s.genome.famille));
  for (const f of FAMILLES) assert.ok(semees.has(f.nom) || f.nom === "modele", f.nom);
});

test("mutations et croisements restent dans les bornes", () => {
  const rnd = hasard(42);
  for (const { genome } of SEMENCES) {
    let g = genome;
    for (let k = 0; k < 200; k++) {
      g = rnd() < 0.7 ? muter(g, rnd) : croiser(g, muter(genome, rnd), rnd);
      assert.ok(estValide(g), cleGenome(g));
    }
  }
});

test("la martingale sans plafond n'est jamais cultivée", () => {
  const stop = FAMILLES.find((f) => f.nom === "stop");
  const def = stop?.params.retournements;
  assert.ok(def && def.type === "reel" && def.max <= 3);
});

test("Benjamini-Hochberg : exemple de manuel", () => {
  // m = 5, α = 0,05 : seuils 0,01 · 0,02 · 0,03 · 0,04 · 0,05
  assert.deepEqual(benjaminiHochberg([0.001, 0.015, 0.04, 0.2, 0.9], 0.05), [true, true, false, false, false]);
  // montée : un p au-dessus de son seuil n'empêche pas un rang suivant de tout emporter
  assert.deepEqual(benjaminiHochberg([0.02, 0.03, 0.035, 0.04], 0.05), [true, true, true, true]);
  assert.deepEqual(benjaminiHochberg([0.5, 0.6], 0.05), [false, false]);
});

test("une récolte est reproductible à graine égale", { skip: !existsSync(JOURNAL) }, () => {
  const w = fenetres();
  const a = recolter(w, { population: 30, generations: 4, tirages: 200, graine: 3 });
  const b = recolter(w, { population: 30, generations: 4, tirages: 200, graine: 3 });
  assert.deepEqual(a.finalistes.map((f) => [f.id, f.p]), b.finalistes.map((f) => [f.id, f.p]));
});

test("l'épreuve reste scellée : aucune fenêtre d'épreuve dans l'entraînement", { skip: !existsSync(JOURNAL) }, () => {
  const r = recolter(fenetres(), { population: 20, generations: 2, tirages: 100 });
  assert.ok((r.fenetres.entrainement.a as number) < (r.fenetres.epreuve.de as number));
});

test("un vrai talent, planté dans les données, est trouvé et promu", { skip: !existsSync(JOURNAL) }, () => {
  // On triche sur l'issue : le gagnant d'une fenêtre regagne la suivante
  // 85 fois sur 100. Une ferme incapable de le voir serait aveugle ; une
  // ferme qui promeut tout serait crédule (le test suivant). Ici, elle doit voir.
  const rnd = hasard(9);
  let avant: 0 | 1 = 1;
  const w = fenetres().map((x, k) => {
    const up: 0 | 1 = k === 0 ? 1 : rnd() < 0.85 ? avant : ((1 - avant) as 0 | 1);
    const y = { ...x, up, previousUp: k === 0 ? null : avant };
    avant = up;
    return y;
  });
  const r = recolter(w, { tirages: 1000 });
  assert.ok(r.finalistes.some((f) => f.promue && f.famille === "serie" && f.genome.p.mode === "suivre"),
    JSON.stringify(r.finalistes.map((f) => [f.libelle, f.p, f.promue])));
});

/**
 * Un marché JUSTE, fabriqué : le prix de chaque côté est exactement sa
 * probabilité de gagner (une marche aléatoire, prix = P(finir au-dessus)).
 * Là, aucune stratégie ne peut gagner autre chose que les frais et
 * l'écart : tout ce que la ferme promouvrait serait un faux positif.
 */
function marcheJuste(nb: number, graine: number): WindowRows[] {
  const rnd = hasard(graine);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  const phi = (x: number) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const e = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
    return x >= 0 ? (1 + e) / 2 : (1 - e) / 2;
  };
  const etapes = 20;
  const out: WindowRows[] = [];
  let avant: 0 | 1 | null = null;
  for (let k = 0; k < nb; k++) {
    const window = 1_800_000_000 + k * 300;
    let x = 0;
    const chemin: number[] = [];
    for (let e = 0; e < etapes; e++) { x += gauss(); chemin.push(x); }
    const final = x + gauss();
    const up: 0 | 1 = final > 0 ? 1 : 0;
    const rows = chemin.map((xe, e) => {
      const reste = etapes - e; // pas restants, chacun de variance 1
      const q = Math.min(0.99, Math.max(0.01, phi(xe / Math.sqrt(reste))));
      const cent = (v: number) => Math.min(0.99, Math.max(0.01, Math.round(v * 100) / 100));
      const elapsed = (e + 1) * 15;
      return {
        window, elapsed, remaining: 300 - elapsed, spot: 100_000 + xe * 20, strike: 100_000, sigma: 20 / Math.sqrt(15), pModel: q,
        upBid: cent(q - 0.01), upAsk: cent(q + 0.01), upSize: 500, downBid: cent(1 - q - 0.01), downAsk: cent(1 - q + 0.01), downSize: 500,
        feeRate: 0.07, upBidSize: 500, upBidDepth: 2000, upAskDepth: 2000, ret15: null, ret60: null, ret300: null, up,
      };
    });
    out.push({ window, rows, up, previousUp: avant });
    avant = up;
  }
  return out;
}

test("dans un marché juste, rien n'est promu (pas de faux positif)", () => {
  for (const graine of [11, 12, 13]) {
    const r = recolter(marcheJuste(400, graine), { tirages: 1000, graine });
    assert.equal(r.promues.length, 0, `graine ${graine} : ` + JSON.stringify(r.finalistes.filter((f) => f.promue).map((f) => [f.libelle, f.p, f.epreuve.moyenne])));
  }
});
