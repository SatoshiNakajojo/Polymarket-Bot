/**
 * Les familles de la ferme de stratégies.
 *
 * Chaque stratégie déjà testée du bureau devient un GÉNOME : une famille (sa
 * logique) et des réglages (ses chiffres). « Favori 90–97 c, dernière minute »
 * devient { famille: "favori", lo: 0.9, hi: 0.97, fin: 60 }. La ferme peut
 * alors en faire pousser des variantes — 88–96 c sur les 45 dernières
 * secondes, par exemple — en restant dans des bornes raisonnables.
 *
 * Chaque famille sait aussi jouer « à pile ou face » : même moment d'entrée,
 * mais côté tiré au hasard (`inverser`). C'est le modèle nul : une stratégie
 * qui ne fait pas mieux que ça n'a aucun talent pour choisir le sens.
 *
 * Les semences reproduisent EXACTEMENT les stratégies d'origine (vérifié par
 * ferme.test.ts) : la ferme part bien de ce qui a été testé, pas d'une copie
 * approximative.
 */
import type { Side } from "@/lib/engine.ts";
import { marketP, type Row } from "./journal-data.ts";
import {
  askOf,
  bidOf,
  Book,
  favorite,
  firstEntry,
  other,
  runStops,
  STAKE,
  type Exec,
  type Strategy,
  type WindowResult,
  type WindowRows,
} from "./strategies.ts";

export type Valeur = number | string | boolean;
export type Reglages = Record<string, Valeur>;
export type Genome = { famille: string; p: Reglages };
/** `inverser` = le modèle nul : même instant d'entrée, côté opposé. */
export type Joueur = (w: WindowRows, exec: Exec, inverser: boolean) => WindowResult | null;

export type Param =
  | { type: "reel"; min: number; max: number; pas: number }
  | { type: "choix"; valeurs: Valeur[] };

export type Famille = {
  nom: string;
  titre: string;
  /** D'où vient la famille : les stratégies testées qu'elle généralise. */
  origine: string;
  params: Record<string, Param>;
  valide?: (p: Reglages) => boolean;
  libelle: (p: Reglages) => string;
  jouer: (p: Reglages) => Joueur;
};

const n = (v: Valeur) => Number(v);
const c = (v: number) => `${Math.round(v * 100)} c`;
const cote = (s: Side, inverser: boolean): Side => (inverser ? other(s) : s);

function dansBande(r: Row, lo: number, hi: number): Side | null {
  const fav = favorite(r);
  const a = fav ? askOf(r, fav) : null;
  return fav && a != null && a >= lo && a < hi ? fav : null;
}

/** Premier relevé où `choisir` donne un côté : on achète, on tient jusqu'au règlement. */
function tenir(choisir: (r: Row, w: WindowRows, i: number) => Side | null): Joueur {
  return (w, exec, inverser) => {
    for (let i = 0; i < w.rows.length; i++) {
      const side = choisir(w.rows[i], w, i);
      if (!side) continue;
      const book = new Book(w, exec);
      if (!book.buy(i, cote(side, inverser), STAKE)) return null;
      return book.settle();
    }
    return null;
  };
}

export const FAMILLES: Famille[] = [
  {
    nom: "bot",
    titre: "Moteur du bot",
    origine: "Normal · Inversé",
    params: { inverse: { type: "choix", valeurs: [false, true] } },
    libelle: (p) => (p.inverse ? "Moteur du bot, inversé" : "Moteur du bot"),
    jouer: (p) => (w, exec, inverser) => {
      const e = firstEntry(w, Boolean(p.inverse));
      if (!e) return null;
      const book = new Book(w, exec);
      if (!book.buy(e.i, cote(e.side, inverser), STAKE)) return null;
      return book.settle();
    },
  },
  {
    nom: "favori",
    titre: "Favori tardif",
    origine: "Favori 90–97 c · Favori tardif confirmé TWAP",
    params: {
      lo: { type: "reel", min: 0.5, max: 0.97, pas: 0.01 },
      hi: { type: "reel", min: 0.55, max: 0.99, pas: 0.01 },
      fin: { type: "reel", min: 15, max: 240, pas: 15 },
      confirme: { type: "choix", valeurs: [false, true] },
      marge: { type: "reel", min: -0.05, max: 0.1, pas: 0.01 },
    },
    valide: (p) => n(p.hi) > n(p.lo) + 0.005,
    libelle: (p) =>
      `Favori ${c(n(p.lo))}–${c(n(p.hi))}, ${n(p.fin)} dernières s` +
      (p.confirme ? `, modèle ≥ prix ${n(p.marge) >= 0 ? "+" : "−"}${c(Math.abs(n(p.marge)))}` : ""),
    jouer: (p) =>
      tenir((r) => {
        const fav = r.remaining <= n(p.fin) ? dansBande(r, n(p.lo), n(p.hi)) : null;
        if (!fav || !p.confirme) return fav;
        const proba = fav === "Up" ? r.pModel : 1 - r.pModel;
        return proba >= (askOf(r, fav) as number) + n(p.marge) ? fav : null;
      }),
  },
  {
    nom: "outsider",
    titre: "Outsider sous-coté",
    origine: "Outsider si TWAP 60 s le voit sous-coté",
    params: {
      lo: { type: "reel", min: 0.55, max: 0.95, pas: 0.01 },
      hi: { type: "reel", min: 0.6, max: 0.98, pas: 0.01 },
      debut: { type: "reel", min: 0, max: 180, pas: 15 },
      finMin: { type: "reel", min: 15, max: 240, pas: 15 },
      marge: { type: "reel", min: 0, max: 0.15, pas: 0.01 },
    },
    valide: (p) => n(p.hi) > n(p.lo) + 0.005 && n(p.debut) + n(p.finMin) < 285,
    libelle: (p) =>
      `Outsider quand le favori est à ${c(n(p.lo))}–${c(n(p.hi))} et le modèle le voit +${c(n(p.marge))}, de ${n(p.debut)} s à ${n(p.finMin)} s de la fin`,
    jouer: (p) =>
      tenir((r) => {
        const fav = r.elapsed >= n(p.debut) && r.remaining >= n(p.finMin) ? dansBande(r, n(p.lo), n(p.hi)) : null;
        if (!fav) return null;
        const out = other(fav);
        const proba = out === "Up" ? r.pModel : 1 - r.pModel;
        return proba >= (askOf(r, out) as number) + n(p.marge) ? out : null;
      }),
  },
  {
    nom: "flux",
    titre: "Saut du marché",
    origine: "Suivre / Contrer un saut du marché ≥ 6 c",
    params: {
      seuil: { type: "reel", min: 0.02, max: 0.15, pas: 0.01 },
      mode: { type: "choix", valeurs: ["suivre", "contrer"] },
      debut: { type: "reel", min: 15, max: 180, pas: 15 },
      finMin: { type: "reel", min: 15, max: 180, pas: 15 },
    },
    valide: (p) => n(p.debut) + n(p.finMin) < 285,
    libelle: (p) =>
      `${p.mode === "suivre" ? "Suivre" : "Contrer"} un saut du marché ≥ ${c(n(p.seuil))}, après ${n(p.debut)} s et avant les ${n(p.finMin)} dernières s`,
    jouer: (p) =>
      tenir((r, w, i) => {
        const prev = i > 0 ? w.rows[i - 1] : null;
        const q = marketP(r);
        const q0 = prev ? marketP(prev) : null;
        if (q == null || q0 == null || r.elapsed < n(p.debut) || r.remaining < n(p.finMin)) return null;
        const s = n(p.seuil);
        const saut: Side | null = q - q0 >= s ? "Up" : q0 - q >= s ? "Down" : null;
        return saut && p.mode === "contrer" ? other(saut) : saut;
      }),
  },
  {
    nom: "serie",
    titre: "Fenêtre d'avant",
    origine: "Rejouer / Contrer le gagnant de la fenêtre d'avant",
    params: {
      mode: { type: "choix", valeurs: ["suivre", "contrer"] },
      debut: { type: "reel", min: 0, max: 240, pas: 15 },
    },
    libelle: (p) => `${p.mode === "suivre" ? "Rejouer" : "Contrer"} le gagnant de la fenêtre d'avant, à ${n(p.debut)} s`,
    jouer: (p) =>
      tenir((r, w) => {
        if (r.elapsed < n(p.debut) || w.previousUp == null) return null;
        const s: Side = w.previousUp ? "Up" : "Down";
        return p.mode === "contrer" ? other(s) : s;
      }),
  },
  {
    nom: "modele",
    titre: "Écart au modèle",
    origine: "idée neuve : le moteur du bot, mais avec ses seuils en réglages",
    params: {
      ecart: { type: "reel", min: 0, max: 0.2, pas: 0.01 },
      finMin: { type: "reel", min: 15, max: 150, pas: 15 },
      finMax: { type: "reel", min: 60, max: 285, pas: 15 },
      inverse: { type: "choix", valeurs: [false, true] },
    },
    valide: (p) => n(p.finMax) >= n(p.finMin) + 15,
    libelle: (p) =>
      `${p.inverse ? "Contre le modèle" : "Avec le modèle"} quand il voit ≥ ${c(n(p.ecart))} d'écart, entre ${n(p.finMax)} s et ${n(p.finMin)} s de la fin`,
    jouer: (p) =>
      tenir((r) => {
        if (r.remaining < n(p.finMin) || r.remaining > n(p.finMax) || r.upAsk == null || r.downAsk == null) return null;
        const eUp = r.pModel - r.upAsk;
        const eDown = 1 - r.pModel - r.downAsk;
        const best: Side = eUp >= eDown ? "Up" : "Down";
        if (Math.max(eUp, eDown) < n(p.ecart)) return null;
        return p.inverse ? other(best) : best;
      }),
  },
  {
    nom: "stop",
    titre: "Stop et retournements",
    origine: "Stop · Inversé + stop · Stop x2 · Martingales (plafonnées à 3)",
    params: {
      inverse: { type: "choix", valeurs: [false, true] },
      facteur: { type: "choix", valeurs: [0, 1, 1.5, 2] },
      retournements: { type: "reel", min: 1, max: 3, pas: 1 },
      ref: { type: "choix", valeurs: ["entree", "strike"] },
      calme: { type: "reel", min: 0, max: 90, pas: 15 },
    },
    // La martingale sans plafond n'est pas cultivée : elle transforme une
    // série perdante ordinaire en ruine, quel que soit son bilan passé.
    libelle: (p) =>
      `${p.inverse ? "Inversé" : "Normal"}, ` +
      (n(p.facteur) === 0
        ? "stop simple"
        : `${n(p.retournements)} retournement${n(p.retournements) > 1 ? "s" : ""} ×${String(p.facteur).replace(".", ",")}`) +
      `, réf. ${p.ref === "strike" ? "prix à battre" : "entrée"}${n(p.calme) ? `, calme ${n(p.calme)} s` : ""}`,
    jouer: (p) => (w, exec, inverser) => {
      const e = firstEntry(w, Boolean(p.inverse));
      if (!e) return null;
      const entree = { i: e.i, side: cote(e.side, inverser) };
      return runStops(w, exec, entree, n(p.facteur), n(p.retournements), p.ref as "entree" | "strike", n(p.calme));
    },
  },
  {
    nom: "profit",
    titre: "Prise de bénéfice",
    origine: "Normal + prise de bénéfice à 95 c",
    params: {
      inverse: { type: "choix", valeurs: [false, true] },
      cible: { type: "reel", min: 0.6, max: 0.99, pas: 0.01 },
    },
    libelle: (p) => `${p.inverse ? "Inversé" : "Normal"} + prise de bénéfice à ${c(n(p.cible))}`,
    jouer: (p) => (w, exec, inverser) => {
      const e = firstEntry(w, Boolean(p.inverse));
      if (!e) return null;
      const book = new Book(w, exec);
      const leg = book.buy(e.i, cote(e.side, inverser), STAKE);
      if (!leg) return null;
      for (let i = e.i + 1; i < w.rows.length; i++) {
        const bid = bidOf(w.rows[i], leg.side);
        if (bid != null && bid >= n(p.cible) && book.sell(i, leg)) break;
      }
      return book.settle();
    },
  },
  {
    nom: "limite",
    titre: "Ordre limite",
    origine: "Ordre limite sur le favori / l'outsider (à 1 min)",
    params: {
      a: { type: "reel", min: 15, max: 240, pas: 15 },
      cote: { type: "choix", valeurs: ["favori", "outsider"] },
      decalage: { type: "reel", min: 0, max: 0.05, pas: 0.01 },
    },
    libelle: (p) =>
      `Ordre limite sur ${p.cote === "favori" ? "le favori" : "l'outsider"} à ${n(p.a)} s` +
      (n(p.decalage) ? `, ${c(n(p.decalage))} sous le meilleur acheteur` : ""),
    // Même hypothèse pessimiste que le bureau : rempli seulement si le prix
    // vendeur descend jusqu'à l'ordre, et sans frais preneur.
    jouer: (p) => (w, _exec, inverser) => {
      const i0 = w.rows.findIndex((r) => r.elapsed >= n(p.a));
      if (i0 < 0) return null;
      const r0 = w.rows[i0];
      const fav = favorite(r0);
      if (!fav) return null;
      const s = cote(p.cote === "favori" ? fav : other(fav), inverser);
      const bid = bidOf(r0, s);
      const prix = bid == null ? null : Math.round((bid - n(p.decalage)) * 100) / 100;
      if (prix == null || !(prix > 0.02)) return null;
      for (let i = i0 + 1; i < w.rows.length; i++) {
        const ask = askOf(w.rows[i], s);
        if (ask != null && ask <= prix + 1e-9) {
          const parts = STAKE / prix;
          const gagne = (w.up === 1) === (s === "Up");
          return { pnl: (gagne ? parts : 0) - STAKE, volume: STAKE, legs: 1, trace: [`+${Math.round(w.rows[i].elapsed)} s · ordre limite ${s} rempli à ${Math.round(prix * 100)} c`] };
        }
      }
      return null;
    },
  },
];

export const famille = (nom: string) => FAMILLES.find((f) => f.nom === nom);

/** Les stratégies déjà testées du bureau, en génomes (la clé est celle de strategies.ts). */
export const SEMENCES: { cle: string; genome: Genome }[] = [
  { cle: "direct", genome: { famille: "bot", p: { inverse: false } } },
  { cle: "inverse", genome: { famille: "bot", p: { inverse: true } } },
  { cle: "stop", genome: { famille: "stop", p: { inverse: false, facteur: 0, retournements: 1, ref: "entree", calme: 0 } } },
  { cle: "inverseStop", genome: { famille: "stop", p: { inverse: true, facteur: 0, retournements: 1, ref: "entree", calme: 0 } } },
  { cle: "flip", genome: { famille: "stop", p: { inverse: false, facteur: 2, retournements: 1, ref: "entree", calme: 0 } } },
  { cle: "mart-e3", genome: { famille: "stop", p: { inverse: false, facteur: 2, retournements: 3, ref: "entree", calme: 0 } } },
  { cle: "mart-s3", genome: { famille: "stop", p: { inverse: false, facteur: 2, retournements: 3, ref: "strike", calme: 0 } } },
  { cle: "mart-s3q", genome: { famille: "stop", p: { inverse: false, facteur: 2, retournements: 3, ref: "strike", calme: 45 } } },
  { cle: "lateFav", genome: { famille: "favori", p: { lo: 0.9, hi: 0.97, fin: 60, confirme: false, marge: 0.02 } } },
  { cle: "lateFavTwap", genome: { famille: "favori", p: { lo: 0.85, hi: 0.97, fin: 60, confirme: true, marge: 0.02 } } },
  { cle: "outsiderTwap", genome: { famille: "outsider", p: { lo: 0.75, hi: 0.9, debut: 60, finMin: 60, marge: 0.03 } } },
  { cle: "tp95", genome: { famille: "profit", p: { inverse: false, cible: 0.95 } } },
  { cle: "flowFollow", genome: { famille: "flux", p: { seuil: 0.06, mode: "suivre", debut: 45, finMin: 45 } } },
  { cle: "flowFade", genome: { famille: "flux", p: { seuil: 0.06, mode: "contrer", debut: 45, finMin: 45 } } },
  { cle: "streak", genome: { famille: "serie", p: { mode: "suivre", debut: 30 } } },
  { cle: "antiStreak", genome: { famille: "serie", p: { mode: "contrer", debut: 30 } } },
  { cle: "makerFav", genome: { famille: "limite", p: { a: 60, cote: "favori", decalage: 0 } } },
  { cle: "makerOut", genome: { famille: "limite", p: { a: 60, cote: "outsider", decalage: 0 } } },
];

/** Des points de départ neufs, pour les familles sans stratégie testée. */
export const IDEES: Genome[] = [
  { famille: "modele", p: { ecart: 0.03, finMin: 30, finMax: 120, inverse: false } },
  { famille: "modele", p: { ecart: 0.08, finMin: 60, finMax: 240, inverse: false } },
  { famille: "modele", p: { ecart: 0.03, finMin: 30, finMax: 120, inverse: true } },
];

/** Une clé stable par génome : deux génomes identiques n'en font qu'un. */
export function cleGenome(g: Genome): string {
  const p = Object.keys(g.p).sort().map((k) => `${k}=${typeof g.p[k] === "number" ? Number((g.p[k] as number).toFixed(4)) : g.p[k]}`);
  return `${g.famille}(${p.join(",")})`;
}

export function joueur(g: Genome): Joueur {
  const f = famille(g.famille);
  if (!f) throw new Error(`famille inconnue : ${g.famille}`);
  return f.jouer(g.p);
}

export function libelle(g: Genome): string {
  const f = famille(g.famille);
  return f ? f.libelle(g.p) : g.famille;
}

/** Un génome en stratégie du bureau (pour le suivi papier). */
export function enStrategie(g: Genome, cle: string): Strategy {
  const j = joueur(g);
  return { key: cle, label: `Ferme · ${libelle(g)}`, run: (w, exec) => j(w, exec, false) };
}

/** Un génome dans ses bornes, arrondi à son pas, et cohérent. */
export function estValide(g: Genome): boolean {
  const f = famille(g.famille);
  if (!f) return false;
  for (const [k, def] of Object.entries(f.params)) {
    const v = g.p[k];
    if (def.type === "reel" && (typeof v !== "number" || v < def.min - 1e-9 || v > def.max + 1e-9)) return false;
    if (def.type === "choix" && !def.valeurs.includes(v)) return false;
  }
  return f.valide ? f.valide(g.p) : true;
}

/* ── Hasard reproductible ─────────────────────────────────────────────── */

/** mulberry32 : une graine donnée rejoue exactement la même récolte. */
export function hasard(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** Une variante : un ou deux réglages bougent, dans leurs bornes. */
export function muter(g: Genome, rnd: () => number): Genome {
  const f = famille(g.famille) as Famille;
  const cles = Object.keys(f.params);
  for (let essai = 0; essai < 20; essai++) {
    const p = { ...g.p };
    const combien = rnd() < 0.6 ? 1 : 2;
    for (let k = 0; k < combien; k++) {
      const cle = cles[Math.floor(rnd() * cles.length)];
      const def = f.params[cle];
      if (def.type === "choix") {
        const autres = def.valeurs.filter((v) => v !== p[cle]);
        if (autres.length) p[cle] = autres[Math.floor(rnd() * autres.length)];
      } else {
        const brut = n(p[cle]) + gauss(rnd) * (def.max - def.min) * 0.15;
        const cale = Math.round((Math.min(def.max, Math.max(def.min, brut)) - def.min) / def.pas) * def.pas + def.min;
        p[cle] = Number(cale.toFixed(4));
      }
    }
    const enfant = { famille: g.famille, p };
    if (estValide(enfant) && cleGenome(enfant) !== cleGenome(g)) return enfant;
  }
  return g;
}

/** Un croisement : chaque réglage vient de l'un ou l'autre parent (même famille). */
export function croiser(a: Genome, b: Genome, rnd: () => number): Genome {
  if (a.famille !== b.famille) return muter(a, rnd);
  for (let essai = 0; essai < 10; essai++) {
    const p: Reglages = {};
    for (const k of Object.keys(a.p)) p[k] = rnd() < 0.5 ? a.p[k] : b.p[k];
    const enfant = { famille: a.famille, p };
    if (estValide(enfant)) return enfant;
  }
  return muter(a, rnd);
}
