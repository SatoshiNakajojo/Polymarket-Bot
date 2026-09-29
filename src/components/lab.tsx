import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCents, formatClock, formatPlain, formatSignedUsd, formatTime } from "@/lib/format";
import { getLab, type Lab as LabData } from "@/lib/lab";
import type { LabOrder, LabWindow } from "@/lib/lab-types";

const POLL_MS = 5000;
const COLORS: Record<string, string> = {
  base: "var(--color-brass)",
  prudent: "var(--color-up)",
  large: "var(--color-down)",
  antichoc: "var(--color-mist)",
};

const hhmm = (sec: number) =>
  new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(sec * 1000);
const ago = (ms: number | null, now: number) =>
  ms == null ? null : Math.max(0, Math.round((now - ms) / 1000));
const signedTone = (n: number) => (n > 0 ? "text-up" : n < 0 ? "text-down" : "text-mist");
/** « 42 s », « 3 min 32 s », « 2 h 53 min », « 3 j 4 h ». */
function duration(sec: number): string {
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, "0")} s`;
  if (sec < 86_400)
    return `${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")} min`;
  return `${Math.floor(sec / 86_400)} j ${Math.floor((sec % 86_400) / 3600)} h`;
}

const SECTIONS = [
  { id: "marche", label: "Marché" },
  { id: "portefeuille", label: "Portefeuille" },
  { id: "reglages", label: "Réglages" },
  { id: "historique", label: "Historique" },
  { id: "laboratoire", label: "Programmes" },
  { id: "fenetres", label: "Fenêtres" },
  { id: "teneur", label: "Teneur de marché" },
  { id: "strategies", label: "Stratégies" },
];

/** Barre qui reste en haut pendant le défilement, pour sauter à chaque partie de la page. */
export function SectionNav() {
  return (
    <nav
      aria-label="Parties de la page"
      className="sticky top-0 z-20 -mx-4 mt-3 overflow-x-auto border-b border-rule bg-canvas/90 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6"
    >
      <ul className="flex gap-1 whitespace-nowrap text-sm">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="inline-flex min-h-9 items-center rounded-md px-2.5 text-mist hover:bg-panel-2 hover:text-ink"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Tout ce qui tourne en papier sur cette machine : programmes, fenêtres, teneur de marché, stratégies. */
export function Lab() {
  const [lab, setLab] = useState<LabData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const next = await getLab();
        if (!stop) {
          setLab(next);
          setFailed(null);
        }
      } catch (error) {
        if (!stop) setFailed(error instanceof Error ? error.message : "Lecture impossible.");
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  if (!lab) {
    return (
      <section className="mt-3 rounded-lg border border-rule bg-panel p-4">
        <h2 className="text-sm font-medium text-ink">Laboratoire papier</h2>
        <p className="mt-2 text-sm text-mist">
          {failed ? `${failed} Nouvel essai dans 5 s.` : "Lecture des programmes papier…"}
        </p>
      </section>
    );
  }
  return (
    <>
      <Services lab={lab} />
      <Windows windows={lab.fenetres} />
      <Maker lab={lab} />
      <Paper lab={lab} />
    </>
  );
}

function Services({ lab }: { lab: LabData }) {
  const now = lab.maintenant;
  const rows = [
    {
      name: "Journal",
      command: "compris dans fenetre-papier",
      age: ago(lab.services.journal.majA, now),
      limit: 60,
      detail: lab.services.journal.source ? `prix ${lab.services.journal.source}` : null,
    },
    {
      name: "Suivi papier",
      command: "pm2 start npm --name fenetre-papier -- run paper",
      age: ago(lab.services.papier.majA, now),
      limit: 60,
      detail: null,
    },
    {
      name: "Teneur de marché",
      command: "pm2 start npm --name fenetre-maker -- run maker",
      age: ago(lab.services.maker.majA, now),
      limit: 30,
      detail:
        lab.services.maker.flux === "direct"
          ? "flux temps réel"
          : lab.services.maker.flux === "secours"
            ? "carnet lu toutes les 3 s"
            : null,
    },
  ];
  return (
    <section
      id="laboratoire"
      className="mt-3 scroll-mt-16 rounded-lg border border-rule bg-panel p-4"
    >
      <h2 className="text-sm font-medium text-ink">Programmes papier sur cette machine</h2>
      <p className="mt-1 text-xs text-mist">
        Aucun de ces programmes ne passe d'ordre réel ni ne lit de clé.
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-3">
        {rows.map((row) => {
          const alive = row.age != null && row.age <= row.limit;
          return (
            <li key={row.name} className="rounded-md border border-rule bg-panel-2 px-3 py-2">
              <p className="flex items-center gap-2 text-sm text-ink">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 rounded-full ${alive ? "bg-up" : "bg-down"}`}
                />
                {row.name}
                <span className="sr-only">{alive ? " en marche" : " arrêté"}</span>
              </p>
              <p className="mt-1 font-mono text-xs text-mist">
                {row.age == null
                  ? "jamais lancé ici"
                  : alive
                    ? `à jour il y a ${row.age} s`
                    : `silencieux depuis ${duration(row.age)}`}
                {row.detail ? ` · ${row.detail}` : ""}
              </p>
              {!alive ? (
                <p className="mt-1 break-all font-mono text-[11px] text-mist">{row.command}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function statusTone(w: LabWindow) {
  if (w.statut === "en cours") return "text-brass";
  if (w.statut === "réglée") return "text-ink";
  return "text-mist";
}

function Windows({ windows }: { windows: LabWindow[] }) {
  return (
    <section id="fenetres" className="mt-3 scroll-mt-16 rounded-lg border border-rule bg-panel p-4">
      <h2 className="text-sm font-medium text-ink">Fenêtres</h2>
      <p className="mt-1 text-xs text-mist">
        Les 12 dernières fenêtres de 5 min, la plus récente en haut.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-mist">
            <tr>
              <th className="py-1 pr-3 font-normal">Heure</th>
              <th className="py-1 pr-3 font-normal">Statut</th>
              <th className="py-1 pr-3 font-normal">Résultat</th>
              <th className="hidden py-1 pr-3 text-right font-normal sm:table-cell">
                Prix à battre
              </th>
              <th className="hidden py-1 pr-3 text-right font-normal sm:table-cell">Prix final</th>
              <th className="hidden py-1 pr-3 text-right font-normal sm:table-cell">Relevés</th>
              <th className="py-1 text-right font-normal">Teneur (base)</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {windows.map((w) => (
              <tr key={w.start} className="border-t border-rule">
                <td className="py-1.5 pr-3 text-ink">{hhmm(w.start)}</td>
                <td className={`py-1.5 pr-3 font-sans ${statusTone(w)}`}>
                  <span className="sm:hidden">
                    {w.statut === "en attente du règlement" ? "en attente" : w.statut}
                  </span>
                  <span className="hidden sm:inline">{w.statut}</span>
                </td>
                <td
                  className={`py-1.5 pr-3 ${w.resultat === "Up" ? "text-up" : w.resultat === "Down" ? "text-down" : "text-mist"}`}
                >
                  {w.resultat ?? "—"}
                  {w.reconstitution === false ? (
                    <span className="font-sans text-xs text-down"> · écart de prix</span>
                  ) : null}
                </td>
                <td className="hidden py-1.5 pr-3 text-right text-ink sm:table-cell">
                  {w.prixABattre ? w.prixABattre.toFixed(2) : "—"}
                </td>
                <td className="hidden py-1.5 pr-3 text-right text-ink sm:table-cell">
                  {w.prixFinal ? w.prixFinal.toFixed(2) : "—"}
                </td>
                <td className="hidden py-1.5 pr-3 text-right text-mist sm:table-cell">
                  {w.releves}
                </td>
                <td
                  className={`py-1.5 text-right ${w.maker ? signedTone(w.maker.pnl) : "text-mist"}`}
                >
                  {w.maker ? formatSignedUsd(w.maker.pnl) : w.statut === "réglée" ? "—" : "…"}
                  {w.maker ? (
                    <span className="hidden text-mist sm:inline">
                      {" "}
                      · {Math.round(w.maker.paires)} paires
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function orderText(o: LabOrder) {
  if (!o) return "aucun";
  return `${formatCents(o.prix)} · ${Math.round(o.devant)} devant`;
}

function Maker({ lab }: { lab: LabData }) {
  const state = lab.maker.etat;
  const variants = lab.maker.variantes;
  const live = new Map((state?.variantes ?? []).map((v) => [v.cle, v]));
  const keys = [...new Set([...variants.map((v) => v.cle), ...live.keys()])];
  const byTime = new Map<number, Record<string, number>>();
  for (const v of variants) {
    for (const p of v.courbe) byTime.set(p.t, { ...(byTime.get(p.t) ?? {}), [v.cle]: p.total });
  }
  const running: Record<string, number> = {};
  const chart = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, values]) => {
      Object.assign(running, values);
      return { t, ...running };
    });
  const baseFills = live.get("base")?.executions ?? [];

  return (
    <section id="teneur" className="mt-3 scroll-mt-16 rounded-lg border border-rule bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-ink">Teneur de marché (papier)</h2>
          <p className="mt-1 text-xs text-mist">
            Ordres d'achat au meilleur prix acheteur sur Up et Down : une paire coûte ~99 c et paie
            1 $. Quatre réglages sur le même flux.
          </p>
        </div>
        {state?.fenetre ? (
          <p className="font-mono text-xs text-mist">
            fenêtre {hhmm(state.fenetre)} · reste {formatClock(state.restant ?? 0)}
          </p>
        ) : null}
      </div>
      {keys.length === 0 ? (
        <p className="mt-3 text-sm text-mist">
          Pas encore de données. Lance fenetre-maker sur cette machine.
        </p>
      ) : (
        <>
          <ul className="mt-3 grid gap-2 sm:hidden">
            {keys.map((key) => {
              const v = variants.find((x) => x.cle === key);
              const l = live.get(key);
              return (
                <li key={key} className="rounded-md border border-rule bg-panel-2 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm text-ink">
                      <span
                        aria-hidden
                        className="mr-2 inline-block h-2 w-2 rounded-full"
                        style={{ background: COLORS[key] ?? "var(--color-mist)" }}
                      />
                      {l?.nom ?? v?.nom ?? key}
                      {l?.pause ? <span className="text-xs text-mist"> · en pause</span> : null}
                    </p>
                    <p className={`font-mono text-sm ${signedTone(v?.total ?? 0)}`}>
                      {formatSignedUsd(v?.total ?? 0)}
                    </p>
                  </div>
                  <p className="mt-1 font-mono text-xs text-mist">
                    paires {formatSignedUsd(v?.paires ?? 0)} ·{" "}
                    {v ? `${v.avecExecutions}/${v.fenetres}` : "0"} fenêtres
                    {v && v.avecExecutions > 0
                      ? ` · ${formatSignedUsd(v.moyenne)}${v.incertitude != null ? ` ± ${formatPlain(v.incertitude, 2)} $` : ""} / fenêtre`
                      : ""}
                  </p>
                  <p className="mt-1 font-mono text-xs text-ink">
                    Up {orderText(l?.ordres.Up ?? null)} · Down {orderText(l?.ordres.Down ?? null)}{" "}
                    · stock {Math.round(l?.stock.Up ?? 0)}/{Math.round(l?.stock.Down ?? 0)}
                  </p>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-mist">
                <tr>
                  <th className="py-1 pr-3 font-normal">Réglage</th>
                  <th className="py-1 pr-3 font-normal">Ordre Up</th>
                  <th className="py-1 pr-3 font-normal">Ordre Down</th>
                  <th className="py-1 pr-3 text-right font-normal">Stock Up / Down</th>
                  <th className="py-1 pr-3 text-right font-normal">Fenêtres</th>
                  <th className="py-1 pr-3 text-right font-normal">P&L total</th>
                  <th className="py-1 pr-3 text-right font-normal">dont paires</th>
                  <th className="py-1 text-right font-normal">Par fenêtre</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {keys.map((key) => {
                  const v = variants.find((x) => x.cle === key);
                  const l = live.get(key);
                  return (
                    <tr key={key} className="border-t border-rule">
                      <td className="py-1.5 pr-3 font-sans text-ink">
                        <span
                          aria-hidden
                          className="mr-2 inline-block h-2 w-2 rounded-full"
                          style={{ background: COLORS[key] ?? "var(--color-mist)" }}
                        />
                        {l?.nom ?? v?.nom ?? key}
                        {l?.pause ? <span className="text-xs text-mist"> · en pause</span> : null}
                      </td>
                      <td className="py-1.5 pr-3 text-ink">{orderText(l?.ordres.Up ?? null)}</td>
                      <td className="py-1.5 pr-3 text-ink">{orderText(l?.ordres.Down ?? null)}</td>
                      <td className="py-1.5 pr-3 text-right text-ink">
                        {Math.round(l?.stock.Up ?? 0)} / {Math.round(l?.stock.Down ?? 0)}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-mist">
                        {v ? `${v.avecExecutions}/${v.fenetres}` : "0"}
                      </td>
                      <td className={`py-1.5 pr-3 text-right ${signedTone(v?.total ?? 0)}`}>
                        {formatSignedUsd(v?.total ?? 0)}
                      </td>
                      <td className={`py-1.5 pr-3 text-right ${signedTone(v?.paires ?? 0)}`}>
                        {formatSignedUsd(v?.paires ?? 0)}
                      </td>
                      <td className={`py-1.5 text-right ${signedTone(v?.moyenne ?? 0)}`}>
                        {v && v.avecExecutions > 0
                          ? `${formatSignedUsd(v.moyenne)}${v.incertitude != null ? ` ± ${formatPlain(v.incertitude, 2)} $` : ""}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {chart.length > 1 ? (
        <div className="mt-4 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-rule)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t: number) => hhmm(t / 1000)}
                stroke="var(--color-mist)"
                tick={{ fill: "var(--color-mist)", fontSize: 11 }}
              />
              <YAxis
                width={56}
                tickFormatter={(v: number) => `${v}\u00a0$`}
                stroke="var(--color-mist)"
                tick={{ fill: "var(--color-mist)", fontSize: 11 }}
              />
              <ReferenceLine y={0} stroke="var(--color-mist)" strokeDasharray="3 3" />
              <Tooltip
                contentStyle={{
                  background: "var(--color-panel-2)",
                  border: "1px solid var(--color-rule)",
                  fontSize: 12,
                }}
                labelFormatter={(t) => `fenêtre ${hhmm(Number(t) / 1000)}`}
                formatter={(value, name) => [
                  formatSignedUsd(Number(value)),
                  variants.find((v) => v.cle === name)?.nom ?? String(name),
                ]}
              />
              <Legend
                formatter={(name) => variants.find((v) => v.cle === name)?.nom ?? String(name)}
                wrapperStyle={{ fontSize: 12 }}
              />
              {variants.map((v) => (
                <Line
                  key={v.cle}
                  type="stepAfter"
                  dataKey={v.cle}
                  dot={false}
                  stroke={COLORS[v.cle] ?? "var(--color-mist)"}
                  strokeWidth={v.cle === "base" ? 2 : 1.5}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      {baseFills.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-xs text-mist">
            Dernières exécutions (réglage Base, fenêtre en cours)
          </h3>
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-ink">
            {[...baseFills].reverse().map((f) => (
              <li key={`${f.t}-${f.side}-${f.price}`}>
                {formatTime(Date.parse(f.t))} · achat {f.side} {formatPlain(f.shares, 1)} parts à{" "}
                {formatCents(f.price)} ({f.how})
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Paper({ lab }: { lab: LabData }) {
  const scores = lab.papier.scores;
  const live = lab.papier.live;
  const liveOf = new Map((live?.strategies ?? []).map((s) => [s.cle, s.ordres]));
  const rows =
    scores?.strategies ??
    (live?.strategies ?? []).map((s) => ({
      key: s.cle,
      label: s.nom,
      depuisLancement: null,
      journal: null,
    }));
  return (
    <section
      id="strategies"
      className="mt-3 scroll-mt-16 rounded-lg border border-rule bg-panel p-4"
    >
      <h2 className="text-sm font-medium text-ink">Stratégies papier (suivi en continu)</h2>
      <p className="mt-1 text-xs text-mist">
        {scores ? `Lancé le ${new Date(scores.lancement).toLocaleString("fr-FR")} · ` : ""}
        mise de départ 5 $, frais compris. « Tout le journal » inclut les fenêtres enregistrées
        avant le lancement.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-mist">
          Pas encore de données. Lance fenetre-papier sur cette machine.
        </p>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-rule sm:hidden">
            {rows.map((row) => {
              const orders = liveOf.get(row.key) ?? [];
              const j = row.journal;
              const f = row.depuisLancement;
              return (
                <li key={row.key} className="py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm text-ink">{row.label}</p>
                    <p className={`font-mono text-sm ${j ? signedTone(j.total) : "text-mist"}`}>
                      {j ? formatSignedUsd(j.total) : "—"}
                    </p>
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-mist">
                    {j ? `${j.trades} trades · ${j.verdict}` : "—"}
                    {f && f.trades > 0 ? ` · depuis le lancement ${formatSignedUsd(f.total)}` : ""}
                  </p>
                  {orders.length ? (
                    <p className="mt-0.5 font-mono text-xs text-brass">{orders.join(" · ")}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="mt-3 hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-mist">
                <tr>
                  <th className="py-1 pr-3 font-normal">Stratégie</th>
                  <th className="py-1 pr-3 font-normal">
                    Fenêtre en cours{live ? ` (${hhmm(live.fenetre)})` : ""}
                  </th>
                  <th className="py-1 pr-3 text-right font-normal">Depuis le lancement</th>
                  <th className="py-1 pr-3 text-right font-normal">Tout le journal</th>
                  <th className="py-1 font-normal">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const orders = liveOf.get(row.key) ?? [];
                  const f = row.depuisLancement;
                  const j = row.journal;
                  return (
                    <tr key={row.key} className="border-t border-rule align-top">
                      <td className="py-1.5 pr-3 text-ink">{row.label}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs text-mist">
                        {orders.length ? orders.join(" · ") : "—"}
                      </td>
                      <td
                        className={`py-1.5 pr-3 text-right font-mono ${f ? signedTone(f.total) : "text-mist"}`}
                      >
                        {f ? `${formatSignedUsd(f.total)} · ${f.trades}` : "—"}
                      </td>
                      <td
                        className={`py-1.5 pr-3 text-right font-mono ${j ? signedTone(j.total) : "text-mist"}`}
                      >
                        {j ? `${formatSignedUsd(j.total)} · ${j.trades}` : "—"}
                      </td>
                      <td
                        className={`py-1.5 text-xs ${j?.verdict === "POSITIF" ? "text-up" : j?.verdict === "perdant" ? "text-down" : "text-mist"}`}
                      >
                        {j?.verdict ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
