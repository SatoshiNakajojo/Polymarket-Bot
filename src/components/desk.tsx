import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, YAxis } from "recharts";
import {
  ENTRY_MAX_REMAINING,
  ENTRY_MIN_REMAINING,
  MAX_SPREAD,
  decide,
  fairUp,
  sideEv,
  takerFeePerShare,
  type Side,
} from "@/lib/engine";
import {
  formatCents,
  formatClock,
  formatPlain,
  formatProb,
  formatSignedUsd,
  formatTime,
  formatUsd,
} from "@/lib/format";
import type { Snapshot } from "@/lib/market-types";
import { getMarketSnapshot } from "@/lib/snapshot";
import { STARTING_CASH, useDesk, type OpenPosition, type PaperTrade } from "@/lib/store";

function useNowSec(serverNow: number | null): number {
  const offset = useRef(0);
  const lastServer = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  if (serverNow != null && lastServer.current !== serverNow) {
    lastServer.current = serverNow;
    offset.current = serverNow * 1000 - Date.now();
  }
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  return (now + offset.current) / 1000;
}

export function Desk() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const armed = useDesk((s) => s.armed);
  const stakeUsd = useDesk((s) => s.stakeUsd);
  const minEdge = useDesk((s) => s.minEdge);
  const lossCap = useDesk((s) => s.lossCap);
  const cash = useDesk((s) => s.cash);
  const trades = useDesk((s) => s.trades);
  const open = useDesk((s) => s.open);
  const hydrated = useDesk((s) => s.hydrated);

  useEffect(() => {
    const pending = useDesk.persist.rehydrate();
    if (pending instanceof Promise) {
      void pending.then(() => useDesk.getState().setHydrated());
    } else {
      useDesk.getState().setHydrated();
    }
  }, []);

  useEffect(() => {
    let stop = false;
    async function pull() {
      try {
        const next = await getMarketSnapshot();
        if (stop) return;
        setSnap(next);
        setFailed(next.ok ? null : next.error);
      } catch (error) {
        if (stop) return;
        setFailed(error instanceof Error ? error.message : "Connexion interrompue.");
      }
    }
    void pull();
    const id = window.setInterval(() => void pull(), 2000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const serverNow = snap?.serverNow ?? null;
  const nowSec = useNowSec(serverNow);

  useEffect(() => {
    if (!snap || !snap.ok || !hydrated) return;
    const state = useDesk.getState();
    if (state.open && snap.previous.complete && state.open.windowStart === snap.previous.start) {
      const outcome: Side = snap.previous.twap >= snap.previous.strike ? "Up" : "Down";
      state.settle(state.open.windowStart, outcome, snap.previous.twap);
    } else if (state.open && state.open.windowStart < snap.live.start - 300) {
      state.voidOpen(state.open.windowStart);
    }

    const fresh = useDesk.getState();
    const lossHalted = fresh.cash - STARTING_CASH <= -fresh.lossCap;
    const fair = fairUp({
      strike: snap.live.strike,
      twap: snap.live.twap,
      price: snap.price,
      elapsedSec: Math.max(0, nowSec - snap.live.start),
      remainingSec: Math.max(0, snap.live.end - nowSec),
      sigmaPerSqrtSec: snap.sigmaPerSqrtSec,
    });
    const market = snap.market;
    const decision = decide({
      remainingSec: Math.max(0, snap.live.end - nowSec),
      pUp: fair.pUp,
      up: market?.up ?? { bid: null, ask: null, askSize: null },
      down: market?.down ?? { bid: null, ask: null, askSize: null },
      stakeUsd: fresh.stakeUsd,
      minOrderSize: snap.minOrderSize,
      feeRate: snap.feeRate,
      minEdge: fresh.minEdge,
      minRemaining: ENTRY_MIN_REMAINING,
      maxRemaining: ENTRY_MAX_REMAINING,
      maxSpread: MAX_SPREAD,
      lossHalted,
      alreadyIn: fresh.open != null || fresh.enteredWindow === snap.live.start,
      armed: fresh.armed,
      marketState: !market ? "missing" : market.acceptingOrders ? "ready" : "closed",
      cash: fresh.cash,
    });
    if (
      decision.action === "buy" &&
      decision.side &&
      decision.ask != null &&
      decision.shares != null &&
      decision.cost != null &&
      decision.fee != null &&
      decision.ev != null
    ) {
      const position: OpenPosition = {
        id: `${snap.live.start}-${decision.side}`,
        windowStart: snap.live.start,
        side: decision.side,
        ask: decision.ask,
        shares: decision.shares,
        cost: decision.cost,
        fee: decision.fee,
        pModel: decision.side === "Up" ? fair.pUp : 1 - fair.pUp,
        ev: decision.ev,
        openedAt: Date.now(),
        strike: snap.live.strike,
      };
      fresh.enter(position);
    }
  }, [snap, hydrated, armed, stakeUsd, minEdge, lossCap, nowSec]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
      <Header cash={cash} armed={armed} pnl={cash - STARTING_CASH} />
      {!snap && !failed ? (
        <p className="mt-10 text-sm text-mist">Lecture du carnet Polymarket et du BTC…</p>
      ) : null}
      {failed && (!snap || !snap.ok) ? (
        <p className="mt-6 max-w-xl text-sm text-down" role="alert">
          {failed} Nouvelle tentative dans un instant.
        </p>
      ) : null}
      {snap?.ok ? <Live snap={snap} nowSec={nowSec} /> : null}
      <Journal trades={trades} open={open} />
      <p className="mt-6 max-w-3xl text-xs leading-relaxed text-mist">
        Papier uniquement. Le règlement simulé compare le TWAP Coinbase de la fenêtre au prix
        d'ouverture. Polymarket, lui, règle sur le TWAP Chainlink BTC/USD — ce n'est pas le même
        oracle. Aucune clé, aucun ordre réel.
      </p>
    </main>
  );
}

function Header({ cash, armed, pnl }: { cash: number; armed: boolean; pnl: number }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
      <div>
        <p className="font-mono text-xs tracking-widest text-brass">BTC · 5 MIN · POLYMARKET</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink">Fenêtre</h1>
        <p className="mt-1 text-sm text-mist">Up ou Down, une fenêtre à la fois. Encaisse fictive.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-full border border-rule px-3 py-1 font-mono text-xs text-mist">
          <span className={`size-1.5 rounded-full bg-brass ${armed ? "fenetre-live" : "opacity-40"}`} />
          {armed ? "BOT PAPIER ARMÉ" : "BOT EN VEILLE"}
        </span>
        <div className="text-right">
          <p className="font-mono text-lg text-ink">{formatUsd(cash, 2)}</p>
          <p className={`font-mono text-xs ${pnl >= 0 ? "text-up" : "text-down"}`}>
            session {formatSignedUsd(pnl)}
          </p>
        </div>
      </div>
    </header>
  );
}

function Live({ snap, nowSec }: { snap: Extract<Snapshot, { ok: true }>; nowSec: number }) {
  const remaining = Math.max(0, snap.live.end - nowSec);
  const elapsed = Math.min(300, Math.max(0, nowSec - snap.live.start));
  const fair = fairUp({
    strike: snap.live.strike,
    twap: snap.live.twap,
    price: snap.price,
    elapsedSec: elapsed,
    remainingSec: remaining,
    sigmaPerSqrtSec: snap.sigmaPerSqrtSec,
  });
  const armed = useDesk((s) => s.armed);
  const stakeUsd = useDesk((s) => s.stakeUsd);
  const minEdge = useDesk((s) => s.minEdge);
  const lossCap = useDesk((s) => s.lossCap);
  const cash = useDesk((s) => s.cash);
  const open = useDesk((s) => s.open);
  const enteredWindow = useDesk((s) => s.enteredWindow);
  const lossHalted = cash - STARTING_CASH <= -lossCap;
  const market = snap.market;
  const decision = decide({
    remainingSec: remaining,
    pUp: fair.pUp,
    up: market?.up ?? { bid: null, ask: null, askSize: null },
    down: market?.down ?? { bid: null, ask: null, askSize: null },
    stakeUsd,
    minOrderSize: snap.minOrderSize,
    feeRate: snap.feeRate,
    minEdge,
    minRemaining: ENTRY_MIN_REMAINING,
    maxRemaining: ENTRY_MAX_REMAINING,
    maxSpread: MAX_SPREAD,
    lossHalted,
    alreadyIn: open != null || enteredWindow === snap.live.start,
    armed,
    marketState: !market ? "missing" : market.acceptingOrders ? "ready" : "closed",
    cash,
  });

  const delta = snap.price - snap.live.strike;
  const bps = snap.live.strike > 0 ? (delta / snap.live.strike) * 10_000 : 0;
  const progress = Math.min(100, Math.max(0, (elapsed / 300) * 100));

  const chart = useMemo(() => {
    const points = snap.live.path.map((point) => ({
      t: point.t,
      price: point.price,
    }));
    if (points.length === 1) {
      const only = points[0];
      if (only) points.unshift({ t: snap.live.start, price: only.price });
    }
    return points;
  }, [snap.live.path, snap.live.start]);

  const prices = chart.map((p) => p.price);
  const lo = Math.min(snap.live.strike, ...prices);
  const hi = Math.max(snap.live.strike, ...prices);
  const pad = Math.max(8, (hi - lo) * 0.25);

  return (
    <div className="mt-5 grid gap-4 lg:grid-cols-12">
      <section className="rounded-lg border border-rule bg-panel p-4 lg:col-span-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-mist">fenêtre en cours</p>
            <p className="mt-1 font-mono text-5xl font-medium tracking-tight text-ink">
              {formatClock(remaining)}
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-xs text-mist">BTC</p>
            <p className="font-mono text-2xl text-ink">{formatUsd(snap.price, 2)}</p>
            <p className={`font-mono text-xs ${delta >= 0 ? "text-up" : "text-down"}`}>
              {delta >= 0 ? "+" : "−"}
              {formatUsd(Math.abs(delta), 2)} · {formatPlain(bps, 1)} bps
            </p>
          </div>
        </div>
        <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-panel-2">
          <div className="h-full bg-brass" style={{ width: `${progress}%` }} />
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3">
          <Stat label="Ouverture" value={formatUsd(snap.live.strike, 2)} />
          <Stat label="TWAP" value={formatUsd(snap.live.twap, 2)} />
          <Stat label="Modèle Up" value={formatProb(fair.pUp)} />
        </dl>
        <div className="mt-4 h-44">
          {chart.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                <YAxis hide domain={[lo - pad, hi + pad]} />
                <ReferenceLine y={snap.live.strike} stroke="var(--color-brass)" strokeDasharray="4 4" />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke="var(--color-ink)"
                  fill="var(--color-panel-2)"
                  strokeWidth={1.75}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-mist">Courbe en attente du premier échantillon.</p>
          )}
        </div>
        <p className="mt-2 text-xs text-mist">
          {market?.title ?? "Slug en attente"} · vol ~{" "}
          {formatUsd(snap.sigmaPerSqrtSec * Math.sqrt(60), 0)} / min · frais taker{" "}
          {formatPlain(snap.feeRate * 100, 1)} % × p × (1−p)
        </p>
      </section>

      <section className="flex flex-col gap-4 lg:col-span-5">
        <div className="grid grid-cols-2 gap-3">
          <QuoteCard
            side="Up"
            quote={market?.up ?? null}
            prob={fair.pUp}
            feeRate={snap.feeRate}
            hot={decision.side === "Up"}
          />
          <QuoteCard
            side="Down"
            quote={market?.down ?? null}
            prob={1 - fair.pUp}
            feeRate={snap.feeRate}
            hot={decision.side === "Down"}
          />
        </div>
        <div
          className={`rounded-lg border bg-panel p-4 ${
            decision.action === "buy"
              ? decision.side === "Down"
                ? "border-down"
                : "border-up"
              : "border-rule"
          }`}
        >
          <p className="font-mono text-xs text-mist">décision</p>
          <p className="mt-1 text-2xl font-semibold text-ink">
            {decision.action === "buy" ? `Acheter ${decision.side === "Up" ? "Up" : "Down"}` : "Attendre"}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-mist">{decision.reason}</p>
          {open ? (
            <p className="mt-3 font-mono text-xs text-ink">
              Position {open.side} · {formatPlain(open.shares, 2)} parts @ {formatCents(open.ask)} · coût{" "}
              {formatUsd(open.cost, 2)}
            </p>
          ) : null}
          {market ? (
            <a
              className="mt-3 inline-flex min-h-11 items-center text-sm text-brass underline-offset-4 hover:underline"
              href={`https://polymarket.com/event/${market.slug}`}
              target="_blank"
              rel="noreferrer"
            >
              Voir le marché sur Polymarket
            </a>
          ) : null}
        </div>
        <Controls />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-mist">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-ink">{value}</dd>
    </div>
  );
}

function QuoteCard({
  side,
  quote,
  prob,
  feeRate,
  hot,
}: {
  side: Side;
  quote: { bid: number | null; ask: number | null; askSize: number | null } | null;
  prob: number;
  feeRate: number;
  hot: boolean;
}) {
  const ask = quote?.ask ?? null;
  const ev = ask == null ? null : sideEv(prob, ask, feeRate);
  const tone = side === "Up" ? "text-up" : "text-down";
  return (
    <article className={`rounded-lg border bg-panel p-3 ${hot ? "border-brass" : "border-rule"}`}>
      <p className={`font-mono text-xs tracking-widest ${tone}`}>{side === "Up" ? "UP" : "DOWN"}</p>
      <p className="mt-2 font-mono text-2xl text-ink">{ask == null ? "—" : formatCents(ask)}</p>
      <p className="mt-2 text-xs text-mist">modèle {formatProb(prob)}</p>
      <p className={`mt-1 font-mono text-xs ${ev != null && ev >= 0 ? "text-brass" : "text-down"}`}>
        {ev == null ? "pas d'ask" : `écart ${formatSignedEdge(ev)}`}
      </p>
      <p className="mt-2 text-xs text-mist">
        {quote?.askSize != null ? `${formatPlain(quote.askSize, 0)} parts au meilleur ask` : "profondeur inconnue"}
      </p>
    </article>
  );
}

function formatSignedEdge(ev: number): string {
  const cents = Math.round(ev * 100);
  const body = `${formatPlain(Math.abs(ev * 100), 0)} c`;
  if (cents > 0) return `+${body}`;
  if (cents < 0) return `−${body}`;
  return body;
}

function Controls() {
  const armed = useDesk((s) => s.armed);
  const stakeUsd = useDesk((s) => s.stakeUsd);
  const minEdge = useDesk((s) => s.minEdge);
  const lossCap = useDesk((s) => s.lossCap);
  const setArmed = useDesk((s) => s.setArmed);
  const setStakeUsd = useDesk((s) => s.setStakeUsd);
  const setMinEdge = useDesk((s) => s.setMinEdge);
  const setLossCap = useDesk((s) => s.setLossCap);
  const reset = useDesk((s) => s.reset);

  return (
    <form
      className="rounded-lg border border-rule bg-panel p-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">Bot papier</p>
          <p className="text-xs text-mist">Entre seulement entre {ENTRY_MAX_REMAINING}s et {ENTRY_MIN_REMAINING}s.</p>
        </div>
        <button
          type="button"
          aria-pressed={armed}
          onClick={() => setArmed(!armed)}
          className={`min-h-11 rounded-md px-4 text-sm font-medium ${
            armed ? "bg-brass text-on-brass" : "border border-rule bg-panel-2 text-ink"
          }`}
        >
          {armed ? "Armé" : "Armer"}
        </button>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field
          label="Mise $"
          value={stakeUsd}
          min={1}
          max={200}
          step={1}
          onChange={(n) => setStakeUsd(clampField(n, 1, 200, 10))}
        />
        <Field
          label="Écart min c"
          value={Math.round(minEdge * 100)}
          min={1}
          max={20}
          step={1}
          onChange={(n) => setMinEdge(clampField(n, 1, 20, 3) / 100)}
        />
        <Field
          label="Perte max $"
          value={lossCap}
          min={10}
          max={500}
          step={10}
          onChange={(n) => setLossCap(clampField(n, 10, 500, 80))}
        />
      </div>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-4 min-h-11 text-sm text-mist underline-offset-4 hover:text-ink hover:underline"
      >
        Remettre l'encaisse à {formatUsd(STARTING_CASH, 0)}
      </button>
      <p className="mt-2 text-xs leading-relaxed text-mist">
        Frais estimés {formatCents(takerFeePerShare(0.5))} par part à 50 c. Taille mini du carnet : 5 parts.
      </p>
    </form>
  );
}

function clampField(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function Field({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-mist">{label}</span>
      <input
        className="mt-1 h-11 w-full rounded-md border border-rule bg-panel-2 px-2 font-mono text-sm text-ink"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Journal({ trades, open }: { trades: PaperTrade[]; open: OpenPosition | null }) {
  return (
    <section className="mt-4 rounded-lg border border-rule bg-panel p-4">
      <h2 className="text-sm font-medium text-ink">Journal</h2>
      {open == null && trades.length === 0 ? (
        <p className="mt-3 text-sm text-mist">
          Aucun trade. Le bot n'achète que si le modèle bat l'ask, frais compris, et que le prix
          s'est déjà éloigné de l'ouverture.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-rule">
          {open ? (
            <li className="flex flex-wrap items-baseline justify-between gap-2 py-3">
              <div>
                <p className="text-sm text-ink">
                  {open.side} ouvert · {formatCents(open.ask)} · modèle {formatProb(open.pModel)}
                </p>
                <p className="font-mono text-xs text-mist">{formatTime(open.openedAt)}</p>
              </div>
              <p className="font-mono text-sm text-mist">en cours</p>
            </li>
          ) : null}
          {trades.map((trade) => (
            <li key={trade.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
              <div>
                <p className="text-sm text-ink">
                  {trade.side} · {formatCents(trade.ask)} ·{" "}
                  {trade.status === "void"
                    ? "fenêtre manquée, mise rendue"
                    : trade.status === "win"
                      ? "gagné"
                      : "perdu"}
                </p>
                <p className="font-mono text-xs text-mist">{formatTime(trade.openedAt)}</p>
              </div>
              <p
                className={`font-mono text-sm ${
                  trade.pnl > 0 ? "text-up" : trade.pnl < 0 ? "text-down" : "text-mist"
                }`}
              >
                {formatSignedUsd(trade.pnl)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
