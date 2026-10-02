/** Ce que la page affiche des programmes papier (journal, suivi, teneur de marché). */
export type LabOrder = { prix: number; taille: number; rempli: number; devant: number } | null;

export type LabMakerState = {
  majA: string;
  fenetre: number | null;
  restant: number | null;
  flux: "direct" | "secours" | null;
  dernierEvenement: string | null;
  variantes: {
    cle: string;
    nom: string;
    pause: boolean;
    ordres: { Up: LabOrder; Down: LabOrder };
    stock: { Up: number; Down: number };
    cout: number;
    executions: { t: string; side: "Up" | "Down"; price: number; shares: number; how: string }[];
  }[];
};

export type LabVariant = {
  cle: string;
  nom: string;
  fenetres: number;
  avecExecutions: number;
  total: number;
  paires: number;
  moyenne: number;
  incertitude: number | null;
  courbe: { t: number; total: number }[];
};

export type LabPaperLive = {
  majA: string;
  fenetre: number;
  strategies: { cle: string; nom: string; ordres: string[] }[];
};

type Summary = { trades: number; total: number; mean: number; se: number };

export type LabPaperScores = {
  majA: string;
  lancement: string;
  strategies: {
    key: string;
    label: string;
    depuisLancement: Summary;
    journal: Summary & { verdict: string };
  }[];
};

export type LabWindow = {
  start: number;
  statut: "en cours" | "réglée" | "en attente du règlement";
  resultat: "Up" | "Down" | null;
  prixABattre: number | null;
  prixFinal: number | null;
  reconstitution: boolean | null;
  releves: number;
  maker: { pnl: number; paires: number; up: number; down: number; executions: number } | null;
};

export type LabIaTrading = {
  ecart: number;
  execution: string;
  trades: number;
  gagnes: number;
  total: number;
  moyenne: number;
  incertitude: number | null;
};

export type LabIa = {
  majA: string;
  fenetres: number;
  objectif: number;
  ecartVerdict: number;
  fenetresTest: number;
  verdict: string;
  explication: string;
  modeles: {
    cle: string;
    nom: string;
    perteModele: number;
    perteMarche: number;
    ecart: { mean: number; se: number; verdict: string };
    trading: LabIaTrading[];
    etapes: number[];
    importance: { signal: string; part: number }[] | null;
    bat: boolean;
  }[];
};

export type LabIaHistory = {
  majA: string;
  fenetres: number;
  verdict: string;
  modeles: { cle: string; ecart: number; incertitude: number; trades: number; pnl: number }[];
};

export type Lab = {
  maintenant: number;
  services: {
    journal: { majA: number | null; source: string | null };
    papier: { majA: number | null };
    maker: { majA: number | null; flux: string | null };
    ia: { majA: number | null };
  };
  fenetres: LabWindow[];
  maker: { etat: LabMakerState | null; variantes: LabVariant[] };
  papier: { scores: LabPaperScores | null; live: LabPaperLive | null };
  ia: { dernier: LabIa | null; historique: LabIaHistory[] };
};
