import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import {
  ENTRY_MIN_REMAINING,
  MAX_SPREAD,
  decide,
  fairUp,
  maxAskForEdge,
  pairLock,
  PAIR_MIN,
  settlementPnl,
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
import { connectLive, depositBridgeAddress, disconnectLive, getLiveSession, placeLiveOrder, placeLiveSell, readWalletBalances, redeemWinnings, returnCashToMetaMask, subscribeLive, type WalletBalances } from "@/lib/live";
import { adoptEquity, equitySnapshot, noteEquity, subscribeEquity } from "@/lib/equity";
import { readEquity, readHistory, saveHistory, type HistoryFile } from "@/lib/history";
import { STARTING_CASH, adoptSaved, currentSaved, restoreDesk, useDesk, type LiveFill, type OpenPosition, type PaperTrade } from "@/lib/store";

function entryNote(
  elapsedSec: number,
  triggerPct: number,
  earlyPct: number,
  invert: boolean,
  plan: "stop" | "double" | "direct",
): string {
  const whole = Math.max(0, Math.floor(elapsedSec));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  const when = minutes > 0 ? `${minutes} min ${String(seconds).padStart(2, "0")} s` : `${seconds} s`;
  const mode = plan === "double" ? "double" : plan === "stop" ? "stop" : "direct";
  return `au bout de ${when} · marché ${triggerPct}/${100 - triggerPct} · seuil ${earlyPct}/${100 - earlyPct} · ${invert ? "inversé" : "normal"} · ${mode}`;
}

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
  const mode = useDesk((s) => s.mode);
  const liveFills = useDesk((s) => s.liveFills);
  const cash = useDesk((s) => s.cash);
  const trades = useDesk((s) => s.trades);
  const open = useDesk((s) => s.open);
  const hydrated = useDesk((s) => s.hydrated);
  const entryWaitMin = useDesk((s) => s.entryWaitMin);
  const earlyPct = useDesk((s) => s.earlyPct);
  const invert = useDesk((s) => s.invert);
  const [liveArmed, setLiveArmed] = useState(false);
  const session = useSyncExternalStore(subscribeLive, getLiveSession, () => null);
  const placing = useRef(false);
  const tries = useRef({ window: 0, n: 0, at: 0, side: "Up" as Side, ask: 0, entry: "" });
  const diskReady = useRef(false);

  useLayoutEffect(() => {
    restoreDesk();
  }, []);

  useEffect(() => {
    let stop = false;
    void readHistory()
      .then((file) => {
        if (stop || !file) return;
        adoptSaved(file as unknown as Parameters<typeof adoptSaved>[0]);
      })
      .finally(() => {
        if (stop) return;
        diskReady.current = true;
        void saveHistory({ data: currentSaved() as HistoryFile });
      });
    void readEquity().then((points) => {
      if (!stop && points.length > 0) adoptEquity(points);
    });
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    const flush = () => {
      if (!useDesk.getState().hydrated) return;
      void saveHistory({ data: currentSaved() as HistoryFile });
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  useEffect(() => {
    if (!hydrated || !diskReady.current) return;
    const id = window.setTimeout(() => {
      void saveHistory({ data: currentSaved() as HistoryFile });
    }, 400);
    return () => {
      window.clearTimeout(id);
      if (useDesk.getState().hydrated) void saveHistory({ data: currentSaved() as HistoryFile });
    };
  }, [hydrated, trades, liveFills, cash, open, mode, stakeUsd, minEdge, lossCap, entryWaitMin, earlyPct, invert, armed]);

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
    if (state.open) {
      const official = snap.settled.find((row) => row.start === state.open?.windowStart);
      if (official) state.settle(state.open.windowStart, official.outcome, snap.previous.twap);
      else if (state.open.windowStart < snap.live.start - 4 * 300) state.voidOpen(state.open.windowStart);
    }
    for (const row of snap.settled) state.settleLive(row.start, row.outcome);

    const fresh = useDesk.getState();
    const liveMode = fresh.mode === "live";
    const lossHalted = liveMode
      ? liveAtRisk(fresh.liveFills) >= fresh.lossCap
      : fresh.cash - STARTING_CASH <= -fresh.lossCap;
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
      maxRemaining: 300 - fresh.entryWaitMin * 60,
      maxSpread: MAX_SPREAD,
      lossHalted,
      alreadyIn: fresh.open != null || fresh.enteredWindow === snap.live.start,
      armed: liveMode ? liveArmed && session != null : fresh.armed,
      marketState: !market ? "missing" : market.acceptingOrders ? "ready" : "closed",
      cash: liveMode ? Number.POSITIVE_INFINITY : fresh.cash,
      invert: fresh.invert,
      earlyPrice: fresh.earlyPct / 100,
    });
    const held = market
      ? fresh.liveFills.filter(
          (fill) => fill.status === "accepted" && !fill.result && fill.windowStart === snap.live.start,
        )
      : [];
    const solo = held.length === 1 ? held[0] : null;
    if (liveMode && market && session && liveArmed && !placing.current && solo) {
      const crossed =
        fresh.btcStop &&
        solo.btc != null &&
        (solo.side === "Up" ? snap.price < solo.btc : snap.price > solo.btc);
      const otherSide = solo.side === "Up" ? "Down" : "Up";
      const otherAsk = otherSide === "Up" ? market.up.ask : market.down.ask;
      const otherToken = otherSide === "Up" ? market.upToken : market.downToken;
      const hedge =
        fresh.pair && otherAsk != null && pairLock(solo.ask, otherAsk, snap.feeRate) >= PAIR_MIN
          ? otherAsk
          : null;
      if (crossed && !fresh.pair) {
        const bid = solo.side === "Up" ? market.up.bid : market.down.bid;
        const tokenId = solo.side === "Up" ? market.upToken : market.downToken;
        if (bid != null) {
          const shares = Math.floor((solo.stake / solo.ask) * 100) / 100;
          placing.current = true;
          void placeLiveSell({ tokenId, shares, minPrice: Math.max(0.01, bid - 0.01) })
            .then((result) => {
              useDesk.getState().upsertLive({
                ...solo,
                result: result.ok ? "stop" : undefined,
                exitPrice: result.ok ? bid : undefined,
                detail: result.ok
                  ? `Stop BTC · vendu vers ${Math.round(bid * 100)} c`
                  : `Stop BTC refusé · ${result.message}`,
              });
            })
            .catch((error: unknown) => {
              useDesk.getState().upsertLive({
                ...solo,
                detail: `Stop BTC refusé · ${error instanceof Error ? error.message : "vente impossible"}`,
              });
            })
            .finally(() => {
              placing.current = false;
            });
          return;
        }
      } else if (hedge != null && otherAsk != null) {
        const shares = Math.floor((solo.stake / solo.ask) * 100) / 100;
        const usd = Math.floor(shares * otherAsk * 100) / 100;
        if (shares >= snap.minOrderSize && usd >= 1) {
          placing.current = true;
          const windowStart = snap.live.start;
          const btc = snap.price;
          void placeLiveOrder({
            tokenId: otherToken,
            amount: usd,
            maxPrice: Math.min(0.99, otherAsk + 0.01),
          })
            .then((result) => {
              useDesk.getState().upsertLive({
                id: `pair-${windowStart}-${otherSide}`,
                windowStart,
                side: otherSide,
                ask: otherAsk,
                stake: result.ok ? result.filledUsd : usd,
                openedAt: Date.now(),
                status: result.ok ? "accepted" : "rejected",
                orderId: result.ok ? result.orderId : null,
                btc,
                detail: result.ok
                  ? `Couverture · ${Math.round(pairLock(solo.ask, otherAsk, snap.feeRate) * 100)} c verrouillés`
                  : result.message,
                entry: "double · deuxième côté",
              });
            })
            .catch((error: unknown) => {
              useDesk.getState().upsertLive({
                id: `pair-${windowStart}-${otherSide}`,
                windowStart,
                side: otherSide,
                ask: otherAsk,
                stake: usd,
                openedAt: Date.now(),
                status: "rejected",
                orderId: null,
                detail: error instanceof Error ? error.message : "Couverture refusée.",
                entry: "double · deuxième côté",
              });
            })
            .finally(() => {
              placing.current = false;
            });
          return;
        }
      }
    }
    if (decision.action !== "buy" || !decision.side || decision.ask == null) {
      const tooLate = snap.live.end - nowSec < ENTRY_MIN_REMAINING;
      if (
        liveMode &&
        tries.current.n > 0 &&
        snap.live.start === tries.current.window &&
        fresh.enteredWindow !== snap.live.start &&
        !placing.current &&
        tooLate
      ) {
        useDesk.getState().lockWindow(snap.live.start);
        useDesk.getState().upsertLive({
          id: `retry-${snap.live.start}`,
          windowStart: snap.live.start,
          side: tries.current.side,
          ask: tries.current.ask,
          stake: fresh.stakeUsd,
          openedAt: Date.now(),
          status: "rejected",
          orderId: null,
          detail: `Refusé après ${tries.current.n} essai${tries.current.n > 1 ? "s" : ""}. Plus le temps.`,
          entry: tries.current.entry,
        });
      } else if (
        liveMode &&
        tries.current.n > 0 &&
        snap.live.start === tries.current.window &&
        fresh.enteredWindow !== snap.live.start &&
        !placing.current
      ) {
        const detail = `Essai ${tries.current.n} · on attend que l'occasion revienne.`;
        const same = fresh.liveFills.some(
          (fill) => fill.id === `retry-${snap.live.start}` && fill.status === "retrying" && fill.detail === detail,
        );
        if (!same) {
          useDesk.getState().upsertLive({
            id: `retry-${snap.live.start}`,
            windowStart: snap.live.start,
            side: tries.current.side,
            ask: tries.current.ask,
            stake: fresh.stakeUsd,
            openedAt: Date.now(),
            status: "retrying",
            orderId: null,
            detail,
            entry: tries.current.entry,
          });
        }
      }
      return;
    }

    if (liveMode) {
      if (!liveArmed || !session || placing.current) return;
      if (fresh.enteredWindow === snap.live.start) return;
      const tokenId = decision.side === "Up" ? market?.upToken : market?.downToken;
      if (!tokenId) return;
      if (tries.current.window !== snap.live.start) {
        tries.current = { window: snap.live.start, n: 0, at: 0, side: decision.side, ask: decision.ask, entry: "" };
      }
      if (tries.current.n >= 3) {
        useDesk.getState().lockWindow(snap.live.start);
        useDesk.getState().upsertLive({
          id: `retry-${snap.live.start}`,
          windowStart: snap.live.start,
          side: tries.current.side,
          ask: tries.current.ask,
          stake: fresh.stakeUsd,
          openedAt: Date.now(),
          status: "rejected",
          orderId: null,
          detail: "Refusé après 3 essais. Le prix est déjà parti.",
          entry: tries.current.entry,
        });
        return;
      }
      if (Date.now() - tries.current.at < 2000) return;
      const side = decision.side;
      const ask = decision.ask;
      const stake = fresh.stakeUsd;
      if (!(stake >= 1)) return;
      const pModel = side === "Up" ? fair.pUp : 1 - fair.pUp;
      const edged = Math.floor((maxAskForEdge(pModel, fresh.minEdge, snap.feeRate) + 1e-9) * 100) / 100;
      const maxPrice = fresh.invert ? Math.min(0.8, Math.floor((ask + 0.01 + 1e-9) * 100) / 100) : Math.min(0.8, edged);
      if (maxPrice + 1e-9 < ask) return;
      const triggerPct = Math.round(Math.max(market?.up.ask ?? 0, market?.down.ask ?? 0) * 100);
      const entry = entryNote(
        Math.max(0, nowSec - snap.live.start),
        triggerPct,
        fresh.earlyPct,
        fresh.invert,
        fresh.pair ? "double" : fresh.btcStop ? "stop" : "direct",
      );
      placing.current = true;
      tries.current.n += 1;
      tries.current.at = Date.now();
      tries.current.side = side;
      tries.current.ask = ask;
      tries.current.entry = entry;
      const windowStart = snap.live.start;
      const attempt = tries.current.n;
      void placeLiveOrder({
        tokenId,
        amount: stake,
        maxPrice,
      })
        .then((result) => {
          if (result.ok) {
            useDesk.getState().lockWindow(windowStart);
            useDesk.getState().upsertLive({
              id: `retry-${windowStart}`,
              windowStart,
              side,
              ask,
              stake: result.filledUsd,
              openedAt: Date.now(),
              status: "accepted",
              orderId: result.orderId,
              btc: snap.price,
              detail: `${result.status} · modèle ${Math.round(pModel * 1000) / 10} %`,
              entry,
            });
            return;
          }
          useDesk.getState().upsertLive({
            id: `retry-${windowStart}`,
            windowStart,
            side,
            ask,
            stake,
            openedAt: Date.now(),
            status: "retrying",
            orderId: null,
            detail: `Essai ${attempt} · ${result.message}`,
            entry,
          });
        })
        .catch((error: unknown) => {
          useDesk.getState().upsertLive({
            id: `retry-${windowStart}`,
            windowStart,
            side,
            ask,
            stake,
            openedAt: Date.now(),
            status: "retrying",
            orderId: null,
            detail: `Essai ${attempt} · ${error instanceof Error ? error.message : "Ordre refusé."}`,
            entry,
          });
        })
        .finally(() => {
          placing.current = false;
        });
      return;
    }

    if (useDesk.getState().mode !== "paper") return;
    if (decision.shares == null || decision.cost == null || decision.fee == null || decision.ev == null) {
      return;
    }
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
        entry: entryNote(
          Math.max(0, nowSec - snap.live.start),
          Math.round(Math.max(market?.up.ask ?? 0, market?.down.ask ?? 0) * 100),
          fresh.earlyPct,
          fresh.invert,
          fresh.pair ? "double" : fresh.btcStop ? "stop" : "direct",
        ),
      };
      fresh.enter(position);
  }, [snap, hydrated, armed, stakeUsd, minEdge, lossCap, nowSec, mode, liveArmed, session]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
      <Header cash={cash} armed={armed} pnl={cash - STARTING_CASH} mode={mode} liveArmed={liveArmed} wallet={session?.wallet ?? null} />
      {!snap && !failed ? (
        <p className="mt-10 text-sm text-mist">Lecture du carnet Polymarket et du BTC…</p>
      ) : null}
      {failed && (!snap || !snap.ok) ? (
        <p className="mt-6 max-w-xl text-sm text-down" role="alert">
          {failed} Nouvelle tentative dans un instant.
        </p>
      ) : null}
      {snap?.ok ? (
        <Live
          snap={snap}
          nowSec={nowSec}
          liveArmed={liveArmed}
          setLiveArmed={setLiveArmed}
          connected={session != null}
          lower={<Portfolio cash={cash} wallet={session?.wallet ?? null} mode={mode} />}
        />
      ) : (
        <Portfolio cash={cash} wallet={session?.wallet ?? null} mode={mode} />
      )}
      <Journal trades={trades} open={open} liveFills={liveFills} nowSec={nowSec} />
      <p className="mt-6 max-w-3xl text-xs leading-relaxed text-mist">
        Le papier et le réel se règlent sur le résultat Polymarket, donc le TWAP Chainlink.
        Le prix vient de ce flux. En réel, l'ordre est un achat FAK signé dans cet onglet : la clé n'est pas enregistrée et
        n'est pas envoyée à cette app. L'historique est écrit sur cet ordinateur, dans
        data/fenetre-history.json. Le bot sans interface, npm run bot, tourne sur le même
        ordinateur, clé dans un fichier local. Tu peux perdre la mise.
      </p>
    </main>
  );
}

function useWalletBalances(address: string | null): { balances: WalletBalances | null; failed: boolean } {
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!address) return;
    let stop = false;
    const tick = () => {
      readWalletBalances(address)
        .then((next) => {
          if (stop) return;
          setBalances(next);
          setFailed(false);
        })
        .catch(() => {
          if (!stop) setFailed(true);
        });
    };
    tick();
    const id = window.setInterval(tick, 20_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [address]);
  return { balances: address ? balances : null, failed: address ? failed : false };
}

function Header({
  cash,
  armed,
  pnl,
  mode,
  liveArmed,
  wallet,
}: {
  cash: number;
  armed: boolean;
  pnl: number;
  mode: "paper" | "live";
  liveArmed: boolean;
  wallet: string | null;
}) {
  const live = mode === "live";
  const on = live ? liveArmed && wallet != null : armed;
  const { balances, failed } = useWalletBalances(wallet);
  const shown = mode === "live" ? (balances?.pusd ?? null) : wallet && balances ? balances.pusd : cash;
  useEffect(() => {
    if (shown != null) noteEquity(shown, mode === "live" || wallet ? "live" : "paper");
  }, [shown, mode, wallet]);
  const [copied, setCopied] = useState(false);
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
      <div>
        <p className="font-mono text-xs tracking-widest text-brass">BTC · 5 MIN · POLYMARKET</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink">Fenêtre</h1>
        <p className="mt-1 text-sm text-mist">
          {live ? "Ordres réels en pUSD, une fenêtre à la fois." : "Up ou Down, une fenêtre à la fois. Encaisse fictive."}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs ${live ? "border-down text-down" : "border-rule text-mist"}`}>
          <span className={`size-1.5 rounded-full ${live ? "bg-down" : "bg-brass"} ${on ? "fenetre-live" : "opacity-40"}`} />
          {live ? (on ? "RÉEL ARMÉ" : "RÉEL EN VEILLE") : armed ? "BOT PAPIER ARMÉ" : "BOT EN VEILLE"}
        </span>
        <div className="text-right">
          {wallet ? (
            <>
              <p className="font-mono text-lg text-ink">
                {balances ? formatUsd(balances.pusd, 2) : failed ? "—" : "…"}
              </p>
              <p className="font-mono text-xs text-mist">
                pUSD libre
                {balances && balances.usdc >= 1 ? ` · USDC ${formatUsd(balances.usdc, 2)}` : ""}
              </p>
              <button
                type="button"
                className="mt-1 max-w-[18rem] break-all text-right font-mono text-xs text-ink sm:max-w-md"
                onClick={() => {
                  void navigator.clipboard.writeText(wallet).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {wallet}
              </button>
              <p className="font-mono text-xs text-brass">{copied ? "Adresse copiée" : "Clique sur l'adresse pour la copier"}</p>
              {!live ? (
                <p className={`font-mono text-xs ${pnl >= 0 ? "text-up" : "text-down"}`}>
                  papier {formatUsd(cash, 2)}
                </p>
              ) : null}
            </>
          ) : live ? (
            <>
              <p className="font-mono text-sm text-ink">non connecté</p>
              <p className="font-mono text-xs text-mist">compte Polymarket</p>
            </>
          ) : (
            <>
              <p className="font-mono text-lg text-ink">{formatUsd(cash, 2)}</p>
              <p className={`font-mono text-xs ${pnl >= 0 ? "text-up" : "text-down"}`}>session {formatSignedUsd(pnl)}</p>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function shorten(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function Live({
  snap,
  nowSec,
  liveArmed,
  setLiveArmed,
  connected,
  lower,
}: {
  snap: Extract<Snapshot, { ok: true }>;
  nowSec: number;
  liveArmed: boolean;
  setLiveArmed: (armed: boolean) => void;
  connected: boolean;
  lower: ReactNode;
}) {
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
  const entryWaitMin = useDesk((s) => s.entryWaitMin);
  const earlyPct = useDesk((s) => s.earlyPct);
  const invert = useDesk((s) => s.invert);
  const pair = useDesk((s) => s.pair);
  const lossCap = useDesk((s) => s.lossCap);
  const cash = useDesk((s) => s.cash);
  const mode = useDesk((s) => s.mode);
  const liveFills = useDesk((s) => s.liveFills);
  const open = useDesk((s) => s.open);
  const enteredWindow = useDesk((s) => s.enteredWindow);
  const liveMode = mode === "live";
  const lossHalted = liveMode ? liveAtRisk(liveFills) >= lossCap : cash - STARTING_CASH <= -lossCap;
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
    maxRemaining: 300 - entryWaitMin * 60,
    maxSpread: MAX_SPREAD,
    lossHalted,
    alreadyIn: open != null || enteredWindow === snap.live.start,
    armed: liveMode ? liveArmed && connected : armed,
    marketState: !market ? "missing" : market.acceptingOrders ? "ready" : "closed",
    cash: liveMode ? Number.POSITIVE_INFINITY : cash,
    invert,
    earlyPrice: earlyPct / 100,
  });
  const upAsk = market?.up.ask ?? null;
  const downAsk = market?.down.ask ?? null;
  const liveOpen = liveMode
    ? (liveFills.find((fill) => fill.status === "accepted" && !fill.result && fill.windowStart === snap.live.start) ?? null)
    : null;
  const otherAsk = liveOpen?.side === "Up" ? downAsk : liveOpen?.side === "Down" ? upAsk : null;
  const hedgeLocked = liveOpen && otherAsk != null ? pairLock(liveOpen.ask, otherAsk, snap.feeRate) : null;
  const marked = liveOpen?.side ?? open?.side ?? decision.side;

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
    <div className="mt-4 flex flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-12">
        <section className="rounded-lg border border-rule bg-panel p-4 lg:col-span-7">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="font-mono text-xs text-mist">fenêtre en cours</p>
              <p className="mt-1 font-mono text-5xl font-medium leading-none tracking-tight text-ink">
                {formatClock(remaining)}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xs text-mist">BTC</p>
              <p className="font-mono text-2xl leading-none text-ink">{formatUsd(snap.price, 2)}</p>
              <p className={`mt-1 font-mono text-xs ${delta >= 0 ? "text-up" : "text-down"}`}>
                {delta >= 0 ? "+" : "−"}
                {formatUsd(Math.abs(delta), 2)} · {formatPlain(bps, 1)} bps
              </p>
            </div>
          </div>
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-panel-2">
            <div className="h-full bg-brass" style={{ width: `${progress}%` }} />
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <Stat label="Ouverture" value={formatUsd(snap.live.strike, 2)} />
            <Stat label="TWAP" value={formatUsd(snap.live.twap, 2)} />
            <Stat label="Modèle Up" value={formatProb(fair.pUp)} />
          </dl>
          <div className="mt-3 h-28">
            {chart.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                  <YAxis hide domain={[lo - pad, hi + pad]} />
                  <ReferenceLine y={snap.live.strike} stroke="var(--color-brass)" strokeDasharray="4 4" />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke="var(--color-ink)"
                    fill="var(--color-brass)"
                    fillOpacity={0.2}
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
          <p className="mt-2 truncate text-xs text-mist">
            {market?.title ?? "Slug en attente"} · vol ~ {formatUsd(snap.sigmaPerSqrtSec * Math.sqrt(60), 0)} / min · σ{" "}
            {formatPlain(snap.sigmaPerSqrtSec, 1)} $/√s · frais {formatPlain(snap.feeRate * 100, 1)} %
          </p>
        </section>

        <div className="flex h-full flex-col gap-3 lg:col-span-5">
          <div className="grid grid-cols-2 gap-3">
            <QuoteCard
              side="Up"
              quote={market?.up ?? null}
              prob={fair.pUp}
              feeRate={snap.feeRate}
              hot={marked === "Up"}
            />
            <QuoteCard
              side="Down"
              quote={market?.down ?? null}
              prob={1 - fair.pUp}
              feeRate={snap.feeRate}
              hot={marked === "Down"}
            />
          </div>
          <div
            className={`flex flex-1 flex-col rounded-lg border bg-panel p-4 ${
              marked === "Down" ? "border-down" : marked === "Up" ? "border-up" : "border-rule"
            }`}
          >
            <p className="font-mono text-xs text-mist">décision</p>
            <p className="mt-1 text-2xl font-semibold text-ink">
              {pair && hedgeLocked != null && hedgeLocked >= PAIR_MIN
                ? "Acheter l'autre côté"
                : decision.action === "buy"
                  ? `Acheter ${decision.side === "Up" ? "Up" : "Down"}`
                  : "Attendre"}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-mist">
              {pair && liveOpen && otherAsk != null && hedgeLocked != null
                ? hedgeLocked >= PAIR_MIN
                  ? `${liveOpen.side === "Up" ? "Down" : "Up"} à ${Math.round(otherAsk * 100)} c. Avec le prix déjà payé, il reste ${Math.round(hedgeLocked * 100)} c par part.`
                  : `L'autre côté n'est pas encore assez bon marché. Il manque ${Math.round(-hedgeLocked * 100)} c.`
                : decision.reason}
            </p>
            {liveOpen ? (
              <p className="mt-3 font-mono text-xs text-ink">
                Position {liveOpen.side} · {formatCents(liveOpen.ask)} · {formatUsd(liveOpen.stake, 0)}
                {liveOpen.btc != null ? ` · BTC ${formatUsd(liveOpen.btc, 0)}` : ""}
              </p>
            ) : open ? (
              <p className="mt-3 font-mono text-xs text-ink">
                Position {open.side} · {formatPlain(open.shares, 2)} parts @ {formatCents(open.ask)} · coût{" "}
                {formatUsd(open.cost, 2)}
              </p>
            ) : null}
            {market ? (
              <a
                className="mt-auto inline-flex min-h-11 items-center pt-3 text-sm text-brass underline-offset-4 hover:underline"
                href={`https://polymarket.com/event/${market.slug}`}
                target="_blank"
                rel="noreferrer"
              >
                Voir le marché sur Polymarket
              </a>
            ) : null}
          </div>
        </div>
      </div>
      {lower}
      <Controls liveArmed={liveArmed} setLiveArmed={setLiveArmed} connected={connected} />
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
        {quote?.askSize != null ? `${formatPlain(quote.askSize, 0)} au meilleur ask` : "profondeur inconnue"}
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

function Controls({
  liveArmed,
  setLiveArmed,
  connected,
}: {
  liveArmed: boolean;
  setLiveArmed: (armed: boolean) => void;
  connected: boolean;
}) {
  const armed = useDesk((s) => s.armed);
  const stakeUsd = useDesk((s) => s.stakeUsd);
  const minEdge = useDesk((s) => s.minEdge);
  const lossCap = useDesk((s) => s.lossCap);
  const entryWaitMin = useDesk((s) => s.entryWaitMin);
  const earlyPct = useDesk((s) => s.earlyPct);
  const invert = useDesk((s) => s.invert);
  const setArmed = useDesk((s) => s.setArmed);
  const setStakeUsd = useDesk((s) => s.setStakeUsd);
  const setMinEdge = useDesk((s) => s.setMinEdge);
  const setLossCap = useDesk((s) => s.setLossCap);
  const setEntryWaitMin = useDesk((s) => s.setEntryWaitMin);
  const setEarlyPct = useDesk((s) => s.setEarlyPct);
  const setInvert = useDesk((s) => s.setInvert);
  const pair = useDesk((s) => s.pair);
  const btcStop = useDesk((s) => s.btcStop);
  const setPair = useDesk((s) => s.setPair);
  const setBtcStop = useDesk((s) => s.setBtcStop);
  const reset = useDesk((s) => s.reset);
  const mode = useDesk((s) => s.mode);
  const setMode = useDesk((s) => s.setMode);

  return (
    <form
      className="rounded-lg border border-rule bg-panel p-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">{mode === "live" ? "Bot réel" : "Bot papier"}</p>
          <p className="text-xs text-mist">
            {pair
              ? "Un côté d'abord, l'autre plus tard quand l'écart paie. Le stop est coupé."
              : `Entre après ${entryWaitMin} min si c'est encore 50/50, ou dès qu'un côté atteint ${earlyPct} %.`}
            {invert ? " Signal inversé." : ""}
            {btcStop ? " Stop si le BTC repasse son prix d'entrée." : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-pressed={mode === "paper"}
            onClick={() => {
              setMode("paper");
              setLiveArmed(false);
            }}
            className={`min-h-11 rounded-md px-3 text-sm ${mode === "paper" ? "bg-brass text-on-brass" : "border border-rule bg-panel-2 text-ink"}`}
          >
            Papier
          </button>
          <button
            type="button"
            aria-pressed={mode === "live"}
            onClick={() => {
              setMode("live");
              setArmed(false);
            }}
            className={`min-h-11 rounded-md px-3 text-sm ${mode === "live" ? "bg-down text-on-brass" : "border border-rule bg-panel-2 text-ink"}`}
          >
            Réel
          </button>
        </div>
      </div>
      {mode === "paper" ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs text-mist">Simulation locale, aucun ordre Polymarket.</p>
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
      ) : (
        <LiveConnect liveArmed={liveArmed} setLiveArmed={setLiveArmed} connected={connected} />
      )}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          label="Attente min"
          value={entryWaitMin}
          min={2}
          max={4}
          step={0.5}
          onChange={(n) => setEntryWaitMin(clampField(n, 2, 4, 3))}
        />
        <Field
          label="Seuil %"
          value={earlyPct}
          min={55}
          max={90}
          step={5}
          onChange={(n) => setEarlyPct(clampField(n, 55, 90, 75))}
        />
        <button
          type="button"
          aria-pressed={invert}
          onClick={() => setInvert(!invert)}
          className={`min-h-11 rounded-md px-3 text-sm ${invert ? "bg-down text-on-brass" : "border border-rule bg-panel-2 text-ink"}`}
        >
          {invert ? "Inversé" : "Inverser"}
        </button>
        <button
          type="button"
          aria-pressed={pair}
          onClick={() => setPair(!pair)}
          className={`min-h-11 rounded-md px-3 text-sm ${pair ? "bg-brass text-on-brass" : "border border-rule bg-panel-2 text-ink"}`}
        >
          {pair ? "Paire active" : "Paire"}
        </button>
        <button
          type="button"
          aria-pressed={btcStop}
          onClick={() => setBtcStop(!btcStop)}
          className={`min-h-11 rounded-md px-3 text-sm ${btcStop ? "bg-brass text-on-brass" : "border border-rule bg-panel-2 text-ink"}`}
        >
          {btcStop ? "Stop BTC" : "Sans stop"}
        </button>
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
        {mode === "live"
          ? "En réel, le plafond compte les pertes réglées plus les mises encore ouvertes."
          : `Frais estimés ${formatCents(takerFeePerShare(0.5))} par part à 50 c. Taille mini du carnet : 5 parts.`}
      </p>
    </form>
  );
}

const LOGIN_KEY = "fenetre-login-v1";

function readLogin(): { funder: string; builderKey: string; builderSecret: string; builderPass: string } {
  const empty = { funder: "", builderKey: "", builderSecret: "", builderPass: "" };
  if (typeof window === "undefined") return empty;
  try {
    const parsed = JSON.parse(localStorage.getItem(LOGIN_KEY) ?? "") as Partial<typeof empty>;
    return {
      funder: typeof parsed.funder === "string" ? parsed.funder : "",
      builderKey: typeof parsed.builderKey === "string" ? parsed.builderKey : "",
      builderSecret: typeof parsed.builderSecret === "string" ? parsed.builderSecret : "",
      builderPass: typeof parsed.builderPass === "string" ? parsed.builderPass : "",
    };
  } catch {
    return empty;
  }
}

function writeLogin(value: { funder: string; builderKey: string; builderSecret: string; builderPass: string }) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LOGIN_KEY, JSON.stringify(value));
}

function LiveConnect({
  liveArmed,
  setLiveArmed,
  connected,
}: {
  liveArmed: boolean;
  setLiveArmed: (armed: boolean) => void;
  connected: boolean;
}) {
  const [key, setKey] = useState("");
  const [funder, setFunder] = useState("");
  const [builderKey, setBuilderKey] = useState("");
  const [builderSecret, setBuilderSecret] = useState("");
  const [builderPass, setBuilderPass] = useState("");
  const [loginReady, setLoginReady] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [bridge, setBridge] = useState<string | null>(null);
  const [bridgeCopied, setBridgeCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const session = useSyncExternalStore(subscribeLive, getLiveSession, () => null);

  useEffect(() => {
    const saved = readLogin();
    setFunder(saved.funder);
    setBuilderKey(saved.builderKey);
    setBuilderSecret(saved.builderSecret);
    setBuilderPass(saved.builderPass);
    setLoginReady(true);
  }, []);

  useEffect(() => {
    if (!loginReady) return;
    writeLogin({ funder, builderKey, builderSecret, builderPass });
  }, [loginReady, funder, builderKey, builderSecret, builderPass]);

  return (
    <div className="mt-4 border-t border-rule pt-4">
      {connected && session ? (
        <p className="font-mono text-xs text-ink">Connecté · {shorten(session.wallet)}</p>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-mist">
            Colle la clé MetaMask. Pour créer le deposit wallet, ajoute la clé builder (polymarket.com → profil →
            Builders). La clé privée n'est pas enregistrée.
          </p>
          <label className="mt-3 block">
            <span className="text-xs text-mist">Clé privée</span>
            <input
              className="mt-1 h-11 w-full rounded-md border border-rule bg-panel-2 px-2 font-mono text-sm text-ink"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          <label className="mt-3 block">
            <span className="text-xs text-mist">Adresse du compte (vide la première fois)</span>
            <input
              className="mt-1 h-11 w-full rounded-md border border-rule bg-panel-2 px-2 font-mono text-sm text-ink"
              autoComplete="off"
              spellCheck={false}
              value={funder}
              placeholder="0x…"
              onChange={(event) => setFunder(event.target.value)}
            />
          </label>
          <label className="mt-3 block">
            <span className="text-xs text-mist">Clé builder</span>
            <input
              className="mt-1 h-11 w-full rounded-md border border-rule bg-panel-2 px-2 font-mono text-sm text-ink"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={builderKey}
              onChange={(event) => setBuilderKey(event.target.value)}
            />
          </label>
          <label className="mt-3 block">
            <span className="text-xs text-mist">Secret builder</span>
            <input
              className="mt-1 h-11 w-full rounded-md border border-rule bg-panel-2 px-2 font-mono text-sm text-ink"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={builderSecret}
              onChange={(event) => setBuilderSecret(event.target.value)}
            />
          </label>
          <label className="mt-3 block">
            <span className="text-xs text-mist">Passphrase builder</span>
            <input
              className="mt-1 h-11 w-full rounded-md border border-rule bg-panel-2 px-2 font-mono text-sm text-ink"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={builderPass}
              onChange={(event) => setBuilderPass(event.target.value)}
            />
          </label>
        </>
      )}
      {message ? <p className="mt-2 whitespace-pre-line text-sm text-ink">{message}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {connected ? (
          <>
          <button
            type="button"
            className="min-h-11 rounded-md border border-rule px-4 text-sm text-ink"
            onClick={() => {
              setLiveArmed(false);
              setConsent(false);
              setMessage(null);
              void disconnectLive();
            }}
          >
            Déconnecter
          </button>
          <button
            type="button"
            disabled={redeeming}
            className="min-h-11 rounded-md bg-brass px-4 text-sm font-medium text-on-brass disabled:opacity-40"
            onClick={() => {
              setRedeeming(true);
              setMessage(null);
              void redeemWinnings()
                .then((text) => setMessage(text))
                .catch((error: unknown) => {
                  const text = error instanceof Error ? error.message : "Récupération impossible.";
                  setMessage(
                    text === "Failed to fetch"
                      ? "Le serveur local n'a pas répondu. Ctrl+C, puis npm run dev, reconnecte, et réessaie."
                      : text,
                  );
                })
                .finally(() => setRedeeming(false));
            }}
          >
            {redeeming ? "Récupération…" : "Récupérer les gains"}
          </button>
          <button
            type="button"
            disabled={returning}
            className="min-h-11 rounded-md border border-rule px-4 text-sm text-ink disabled:opacity-40"
            onClick={() => {
              setReturning(true);
              setMessage(null);
              void returnCashToMetaMask()
                .then((text) => setMessage(text))
                .catch((error: unknown) => {
                  const text = error instanceof Error ? error.message : "Renvoi impossible.";
                  setMessage(
                    text.includes("Relayer API Key") || text.includes("Builder API Key")
                      ? "Reconnecte avec la clé builder, puis réessaie."
                      : text,
                  );
                })
                .finally(() => setReturning(false));
            }}
          >
            {returning ? "Renvoi…" : "Renvoyer vers MetaMask"}
          </button>
          <button
            type="button"
            className="min-h-11 rounded-md bg-brass px-4 text-sm font-medium text-on-brass"
            onClick={() => {
              if (!session) return;
              setMessage(null);
              void depositBridgeAddress(session.wallet)
                .then(setBridge)
                .catch((error: unknown) => {
                  setMessage(error instanceof Error ? error.message : "Dépôt impossible.");
                });
            }}
          >
            Adresse pour déposer
          </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy || key.trim().length === 0}
            className="min-h-11 rounded-md bg-brass px-4 text-sm font-medium text-on-brass disabled:opacity-40"
            onClick={() => {
              setBusy(true);
              setMessage(null);
              void connectLive(key, funder, {
                key: builderKey,
                secret: builderSecret,
                passphrase: builderPass,
              })
                .then(() => {
                  setKey("");
                  setMessage(null);
                })
                .catch((error: unknown) => {
                  setMessage(error instanceof Error ? error.message : "Connexion impossible.");
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Connexion…" : "Connecter"}
          </button>
        )}
      </div>
      {bridge ? (
        <div className="mt-3">
          <p className="text-xs leading-relaxed text-mist">
            Dans MetaMask, réseau Polygon, envoie l'USDC à cette adresse de pont. Pas à l'adresse
            du bot. Minimum 2 $. Le pUSD arrivera sur le wallet du bot.
          </p>
          <button
            type="button"
            className="mt-2 max-w-full break-all text-left font-mono text-xs text-ink"
            onClick={() => {
              void navigator.clipboard.writeText(bridge).then(() => {
                setBridgeCopied(true);
                window.setTimeout(() => setBridgeCopied(false), 2000);
              });
            }}
          >
            {bridge}
          </button>
          <p className="font-mono text-xs text-brass">{bridgeCopied ? "Adresse copiée" : "Clique pour copier"}</p>
        </div>
      ) : null}
      <label className="mt-4 flex min-h-11 items-start gap-3 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={consent}
          onChange={(event) => {
            setConsent(event.target.checked);
            if (!event.target.checked) setLiveArmed(false);
          }}
        />
        <span>J'autorise des achats FAK en pUSD sur le marché BTC 5 min. Je peux tout perdre.</span>
      </label>
      <button
        type="button"
        disabled={!connected || !consent}
        aria-pressed={liveArmed}
        onClick={() => setLiveArmed(!liveArmed)}
        className={`mt-3 min-h-11 rounded-md px-4 text-sm font-medium disabled:opacity-40 ${
          liveArmed ? "bg-down text-on-brass" : "border border-rule bg-panel-2 text-ink"
        }`}
      >
        {liveArmed ? "Réel armé" : "Armer le réel"}
      </button>
    </div>
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

function livePnl(fill: LiveFill): number {
  if (fill.status !== "accepted" || !fill.result) return 0;
  if (fill.result === "stop") {
    const exit = fill.exitPrice ?? 0;
    const shares = fill.ask > 0 ? fill.stake / fill.ask : 0;
    return shares * exit - fill.stake - shares * (takerFeePerShare(fill.ask) + takerFeePerShare(exit));
  }
  return settlementPnl(fill.stake, fill.ask, fill.result === "win");
}

function liveAtRisk(fills: LiveFill[]): number {
  let pnl = 0;
  let pending = 0;
  for (const fill of fills) {
    if (fill.status !== "accepted") continue;
    if (!fill.result) pending += fill.stake;
    else pnl += livePnl(fill);
  }
  return pending + Math.max(0, -pnl);
}

const EMPTY_EQUITY: { t: number; value: number; source: "live" | "paper" }[] = [];

function withNow(stored: { t: number; value: number }[], value: number) {
  const now = Date.now();
  const points = stored.filter((point) => point.t < now - 1500);
  points.push({ t: now, value });
  if (points.length === 1) points.unshift({ t: now - 60_000, value });
  return points;
}

function Portfolio({
  cash,
  wallet,
  mode,
}: {
  cash: number;
  wallet: string | null;
  mode: "paper" | "live";
}) {
  const { balances } = useWalletBalances(wallet);
  const shown = mode === "live" ? (balances?.pusd ?? null) : wallet && balances ? balances.pusd : cash;
  const source = mode === "live" || wallet ? "live" : "paper";
  const stored = useSyncExternalStore(subscribeEquity, () => equitySnapshot(source), () => EMPTY_EQUITY);
  const points = shown == null ? [] : withNow(stored, shown);
  const first = points[0]?.value ?? shown ?? 0;
  const last = shown ?? points[points.length - 1]?.value ?? 0;
  const change = last - first;
  const values = points.map((point) => point.value);
  const lo = values.length ? Math.min(...values) : last;
  const hi = values.length ? Math.max(...values) : last;
  const pad = hi - lo < 0.5 ? 1 : Math.max(0.25, (hi - lo) * 0.12);

  return (
    <section className="rounded-lg border border-rule bg-panel p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-ink">Portefeuille</h2>
          <p className="mt-1 text-xs text-mist">Même chiffre que le total en haut, relevé au fil du temps.</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg text-ink">{shown == null ? "…" : formatUsd(shown, 2)}</p>
          <p className={`font-mono text-xs ${change >= 0 ? "text-up" : "text-down"}`}>
            {shown == null ? "solde en lecture" : formatSignedUsd(change)}
          </p>
        </div>
      </div>
      <div className="mt-3 h-44">
        {shown != null && points.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t: number) => {
                  const span = (points[points.length - 1]?.t ?? t) - (points[0]?.t ?? t);
                  return new Date(t).toLocaleTimeString("fr-FR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: span < 10 * 60_000 ? "2-digit" : undefined,
                  });
                }}
                stroke="var(--color-mist)"
                tick={{ fill: "var(--color-mist)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
              />
              <YAxis
                domain={[lo - pad, hi + pad]}
                tickFormatter={(v: number) => formatUsd(v, hi - lo < 50 ? 2 : 0)}
                stroke="var(--color-mist)"
                tick={{ fill: "var(--color-mist)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={84}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={change >= 0 ? "var(--color-up)" : "var(--color-down)"}
                fill={change >= 0 ? "var(--color-up)" : "var(--color-down)"}
                fillOpacity={0.22}
                strokeWidth={1.75}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-mist">En attente du solde.</p>
        )}
      </div>
    </section>
  );
}

function Journal({
  trades,
  open,
  liveFills,
  nowSec,
}: {
  trades: PaperTrade[];
  open: OpenPosition | null;
  liveFills: LiveFill[];
  nowSec: number;
}) {
  return (
    <section className="mt-3 grid items-start gap-3 lg:grid-cols-2">
      <article className="rounded-lg border border-rule bg-panel p-4">
        <h2 className="text-sm font-medium text-ink">Historique réel</h2>
        {liveFills.length === 0 ? (
          <p className="mt-3 text-sm text-mist">Aucun ordre réel pour l'instant.</p>
        ) : (
          <ul className="mt-3 divide-y divide-rule">
            {liveFills.map((fill) => {
              const pending = fill.status === "accepted" && !fill.result;
              const live = pending && nowSec < fill.windowStart + 300;
              const pnl = fill.result === "stop" ? livePnl(fill) : fill.result ? settlementPnl(fill.stake, fill.ask, fill.result === "win") : null;
              return (
                <li key={fill.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                  <div>
                    <p className="text-sm text-ink">
                      {fill.side} · {formatCents(fill.ask)} · {formatUsd(fill.stake, 0)} ·{" "}
                      {fill.status === "rejected"
                        ? "refusé"
                        : fill.status === "retrying"
                          ? "essai"
                          : fill.result === "win"
                            ? "gagné"
                            : fill.result === "loss"
                              ? "perdu"
                              : fill.result === "stop"
                                ? "stop"
                              : live
                                ? "en cours"
                                : "en attente"}
                    </p>
                    <p className="font-mono text-xs text-mist">
                      {formatTime(fill.openedAt)}
                      {fill.orderId ? ` · ${fill.orderId.slice(0, 10)}…` : ""} · {fill.detail}
                    </p>
                    {fill.entry ? <p className="font-mono text-xs text-mist">{fill.entry}</p> : null}
                  </div>
                  <p
                    className={`font-mono text-sm ${
                      fill.result === "win" ? "text-up" : fill.result === "loss" || fill.status === "rejected" ? "text-down" : "text-mist"
                    }`}
                  >
                    {pnl == null ? (fill.status === "rejected" ? "échec" : fill.status === "retrying" ? `${fill.detail.match(/\d+/)?.[0] ?? "…"}` : "…") : formatSignedUsd(pnl)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </article>
      <article className="rounded-lg border border-rule bg-panel p-4">
        <h2 className="text-sm font-medium text-ink">Historique papier</h2>
        {open == null && trades.length === 0 ? (
          <p className="mt-3 text-sm text-mist">Aucun trade papier pour l'instant.</p>
        ) : (
          <ul className="mt-3 divide-y divide-rule">
            {open ? (
              <li className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                <div>
                  <p className="text-sm text-ink">
                    {open.side} · {formatCents(open.ask)} · modèle {formatProb(open.pModel)}
                  </p>
                  <p className="font-mono text-xs text-mist">{formatTime(open.openedAt)}</p>
                  {open.entry ? <p className="font-mono text-xs text-mist">{open.entry}</p> : null}
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
                  {trade.entry ? <p className="font-mono text-xs text-mist">{trade.entry}</p> : null}
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
      </article>
    </section>
  );
}
