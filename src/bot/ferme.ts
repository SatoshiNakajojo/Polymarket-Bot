/**
 * La ferme de stratégies : fait pousser des variantes des stratégies déjà
 * testées, et ne promeut que celles qui battent le hasard sur des fenêtres
 * qu'elles n'ont jamais vues. Aucun ordre, aucune clé : elle lit le journal.
 *
 *   npm run ferme                     une récolte
 *   npm run ferme -- --boucle 6       une récolte toutes les 6 h (pour pm2)
 *   npm run ferme -- --tirages 5000 --generations 20 --graine 7
 *
 * Écrit dans data/ferme/ :
 *   ferme.json        la dernière récolte, en détail (lue par le vaisseau)
 *   promues.json      les stratégies promues — le suivi papier les ajoute
 *   historique.jsonl  une ligne par récolte
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { loadJournal } from "./journal-data.ts";
import { recolter, REGLAGES, type Reglages } from "./ferme-recolte.ts";
import { groupWindows } from "./strategies.ts";

const DIR = process.env.JOURNAL_DIR ?? "data/journal";
const FERME = process.env.FERME_DIR ?? "data/ferme";

function options(argv: string[]) {
  const o: Partial<Reglages> & { boucle?: number } = {};
  const nombres: Record<string, keyof Reglages> = {
    "--tirages": "tirages", "--generations": "generations", "--population": "population",
    "--finalistes": "finalistes", "--graine": "graine", "--min-trades": "minTrades",
  };
  for (let i = 0; i < argv.length; i++) {
    const v = Number(argv[i + 1]);
    if (argv[i] === "--boucle" && v > 0) o.boucle = v;
    else if (nombres[argv[i]] && Number.isFinite(v)) (o as Record<string, number>)[nombres[argv[i]]] = v;
  }
  return o;
}

function ecrire(fichier: string, contenu: string) {
  writeFileSync(`${fichier}.tmp`, contenu);
  renameSync(`${fichier}.tmp`, fichier); // jamais un fichier à moitié écrit pour le vaisseau
}

const signe = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} $`;

function recolte(reglages: Partial<Reglages>) {
  const debut = Date.now();
  let fenetres;
  try {
    fenetres = groupWindows(loadJournal(DIR).rows);
  } catch (e) {
    console.log(e instanceof Error ? e.message : e);
    return;
  }
  if (fenetres.length < 100) {
    console.log(`Ferme : ${fenetres.length} fenêtres réglées seulement. Il en faut au moins 100 (un peu plus de 8 h de journal).`);
    return;
  }
  const r = recolter(fenetres, reglages);
  const duree = Math.round((Date.now() - debut) / 1000);
  mkdirSync(FERME, { recursive: true });
  ecrire(`${FERME}/ferme.json`, JSON.stringify({ majA: new Date().toISOString(), dureeS: duree, ...r }, null, 2));
  ecrire(`${FERME}/promues.json`, JSON.stringify({ majA: new Date().toISOString(), strategies: r.promues }, null, 2));
  appendFileSync(`${FERME}/historique.jsonl`, JSON.stringify({
    majA: new Date().toISOString(), fenetres: r.fenetres.total, evaluees: r.evaluees,
    finalistes: r.finalistes.length, survivants: r.criblage.survivants, promues: r.promues.map((p) => p.id),
  }) + "\n");

  console.log(`\n=== Ferme de stratégies · ${r.fenetres.total} fenêtres · ${r.evaluees} variantes essayées en ${duree} s`);
  console.log(`   Entraînement : ${r.fenetres.entrainement.n} fenêtres · épreuve scellée : ${r.fenetres.epreuve.n} fenêtres`);
  console.log(`   ${"Finaliste".padEnd(70)} ${"entraîn.".padStart(9)} ${"épreuve".padStart(9)}  trades      p   verdict`);
  for (const f of r.finalistes) {
    console.log(
      `   ${f.libelle.slice(0, 70).padEnd(70)} ${signe(f.entrainement.moyenne).padStart(9)} ${signe(f.epreuve.moyenne).padStart(9)}  ${String(f.epreuve.trades).padStart(6)}  ${f.p.toFixed(4)}   ${f.promue ? "PROMUE" : f.raison}`,
    );
  }
  console.log(`   Criblage : ${r.criblage.bruts} sur ${r.criblage.testees} battent le hasard (≈ ${r.criblage.attendues} attendues sans aucun talent), ${r.criblage.survivants} survivent à la correction.`);
  console.log(`   ${r.criblage.resolution}`);
  console.log(`   ${r.verdict}\nDétail dans ${FERME}/ferme.json.\n`);
}

const o = options(process.argv.slice(2));
const { boucle, ...reglages } = o;
console.log(`Ferme de stratégies · aucune clé, aucun ordre · réglages : ${JSON.stringify({ ...REGLAGES, ...reglages })}`);
recolte(reglages);
if (boucle) {
  console.log(`Prochaine récolte dans ${boucle} h.`);
  setInterval(() => recolte(reglages), boucle * 3600 * 1000);
}
