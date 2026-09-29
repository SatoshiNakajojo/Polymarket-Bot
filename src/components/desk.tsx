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
import { STARTING_CASH, adoptSaved, currentSaved, paperLabel, PAPER_PLANS, restoreDesk, useDesk, type LiveFill, type OpenPosition, type PaperPlan, type PaperTrade } from "@/lib/store";

function entryNote(elapsedSec: number, triggerPct: number, earlyPct: number, plan: PaperPlan): string {
  const whole = Math.max(0, Math.floor(elapsedSec));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  const when = minutes > 0 ? `${minutes} min ${String(seconds).padStart(2, "0")} s` : `${seconds} s`;
  const tag = plan === "inverse" ? "inversé" : plan === "direct" ? "normal" : plan;
  return `au bout de ${when} · marché ${triggerPct}/${100 - triggerPct} · seuil ${earlyPct}/${100 - earlyPct} · ${tag}`;
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
  const books = useDesk((s) => s.books);
  const paperOn = useDesk((s) => s.paperOn);
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
  }, [hydrated, trades, liveFills, cash, open, books, mode, stakeUsd, minEdge, lossCap, entryWaitMin, earlyPct, invert, armed]);

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
    for (const plan of PAPER_PLANS) {
      const open = state.books[plan].open;
      if (!open) continue;
      const official = snap.settled.find((row) => row.start === open.windowStart);
      if (official) state.settleBook(plan, open.windowStart, official.outcome, snap.previous.twap);
      else if (open.windowStart < snap.live.start - 4 * 300) state.voidBook(plan, open.windowStart);
    }
    for (const row of snap.settled) state.settleLive(row.start, row.outcome);

    const fresh = useDesk.getState();
    const liveMode = fresh.mode === "live";
    const livePlan = fresh.livePlan;
    const liveInvert = livePlan === "inverse";
    const livePair = livePlan === "double";
    const liveStop = livePlan === "stop";
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
      invert: liveMode ? liveInvert : false,
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
        liveStop &&
        solo.btc != null &&
        (solo.side === "Up" ? snap.price < solo.btc : snap.price > solo.btc);
      const otherSide = solo.side === "Up" ? "Down" : "Up";
      const otherAsk = otherSide === "Up" ? market.up.ask : market.down.ask;
      const otherToken = otherSide === "Up" ? market.upToken : market.downToken;
      const hedge =
        livePair && otherAsk != null && pairLock(solo.ask, otherAsk, snap.feeRate) >= PAIR_MIN
          ? otherAsk
          : null;
      if (crossed && !livePair) {
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
      if (liveMode) return;
    } else if (liveMode) {
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
      const maxPrice = liveInvert ? Math.min(0.8, Math.floor((ask + 0.01 + 1e-9) * 100) / 100) : Math.min(0.8, edged);
      if (maxPrice + 1e-9 < ask) return;
      const triggerPct = Math.round(Math.max(market?.up.ask ?? 0, market?.down.ask ?? 0) * 100);
      const entry = entryNote(
        Math.max(0, nowSec - snap.live.start),
        triggerPct,
        fresh.earlyPct,
        livePlan,
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

    if (useDesk.getState().mode !== "paper" || !market) return;
    const triggerPct = Math.round(Math.max(market.up.ask ?? 0, market.down.ask ?? 0) * 100);
    const elapsed = Math.max(0, nowSec - snap.live.start);
    for (const plan of PAPER_PLANS) {
      const now = useDesk.getState();
      if (!now.paperOn[plan]) continue;
      const book = now.books[plan];
      if (plan === "stop" && book.open?.btc != null && !book.open.hedge) {
        const crossed = book.open.side === "Up" ? snap.price < book.open.btc : snap.price > book.open.btc;
        const bid = book.open.side === "Up" ? market.up.bid : market.down.bid;
        if (crossed && bid != null) {
          now.stopBook(plan, bid);
          continue;
        }
      }
      if (plan === "double" && book.open && !book.open.hedge) {
        const otherSide = book.open.side === "Up" ? "Down" : "Up";
        const otherAsk = otherSide === "Up" ? market.up.ask : market.down.ask;
        if (otherAsk != null && pairLock(book.open.ask, otherAsk, snap.feeRate) >= PAIR_MIN) {
          const shares = book.open.shares;
          const fee = shares * takerFeePerShare(otherAsk, snap.feeRate);
          const cost = shares * otherAsk + fee;
          if (shares >= snap.minOrderSize && cost <= book.cash) {
            now.hedgeBook(plan, { side: otherSide, ask: otherAsk, shares, cost, fee });
          }
        }
      }
      const current = useDesk.getState().books[plan];
      const choice = decide({
        remainingSec: Math.max(0, snap.live.end - nowSec),
        pUp: fair.pUp,
        up: market.up,
        down: market.down,
        stakeUsd: now.stakeUsd,
        minOrderSize: snap.minOrderSize,
        feeRate: snap.feeRate,
        minEdge: now.minEdge,
        minRemaining: ENTRY_MIN_REMAINING,
        maxRemaining: 300 - now.entryWaitMin * 60,
        maxSpread: MAX_SPREAD,
        lossHalted: current.cash - STARTING_CASH <= -now.lossCap,
        alreadyIn: current.open != null || current.enteredWindow === snap.live.start,
        armed: now.armed,
        marketState: market.acceptingOrders ? "ready" : "closed",
        cash: current.cash,
        invert: plan === "inverse",
        earlyPrice: now.earlyPct / 100,
      });
      if (choice.action !== "buy" || !choice.side || choice.ask == null || choice.shares == null || choice.cost == null || choice.fee == null || choice.ev == null) {
        continue;
      }
      useDesk.getState().enterBook(plan, {
        id: `${snap.live.start}-${plan}-${choice.side}`,
        windowStart: snap.live.start,
        side: choice.side,
        ask: choice.ask,
        shares: choice.shares,
        cost: choice.cost,
        fee: choice.fee,
        pModel: choice.side === "Up" ? fair.pUp : 1 - fair.pUp,
        ev: choice.ev,
        openedAt: Date.now(),
        strike: snap.live.strike,
        btc: snap.price,
        entry: entryNote(elapsed, triggerPct, now.earlyPct, plan),
      });
    }
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
      <Journal books={books} paperOn={paperOn} liveFills={liveFills} nowSec={nowSec} mode={mode} />
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
          {live ? "Ordres réels en pUSD, une fenêtre à la fois." : "Quatre stratégies papier en parallèle, chacune avec son historique."}
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
                  papier normal {formatUsd(cash, 2)}
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
              <p className={`font-mono text-xs ${pnl >= 0 ? "text-up" : "text-down"}`}>normal {formatSignedUsd(pnl)}</p>
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
  const livePlan = useDesk((s) => s.livePlan);
  const lossCap = useDesk((s) => s.lossCap);
  const cash = useDesk((s) => s.cash);
  const mode = useDesk((s) => s.mode);
  const liveFills = useDesk((s) => s.liveFills);
  const open = useDesk((s) => s.open);
  const enteredWindow = useDesk((s) => s.enteredWindow);
  const liveMode = mode === "live";
  const invert = liveMode && livePlan === "inverse";
  const pair = liveMode && livePlan === "double";
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
  const setArmed = useDesk((s) => s.setArmed);
  const setStakeUsd = useDesk((s) => s.setStakeUsd);
  const setMinEdge = useDesk((s) => s.setMinEdge);
  const setLossCap = useDesk((s) => s.setLossCap);
  const setEntryWaitMin = useDesk((s) => s.setEntryWaitMin);
  const setEarlyPct = useDesk((s) => s.setEarlyPct);
  const paperOn = useDesk((s) => s.paperOn);
  const setPaperOn = useDesk((s) => s.setPaperOn);
  const livePlan = useDesk((s) => s.livePlan);
  const setLivePlan = useDesk((s) => s.setLivePlan);
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
            {mode === "live"
              ? `Réel : ${paperLabel(livePlan)} seulement. Entre après ${entryWaitMin} min, ou dès ${earlyPct} %.`
              : `Papier : les stratégies allumées tournent ensemble. Entre après ${entryWaitMin} min, ou dès ${earlyPct} %.`}
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
        <Field
          label="Perte max $"
          value={lossCap}
          min={10}
          max={500}
          step={10}
          onChange={(n) => setLossCap(clampField(n, 10, 500, 80))}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {mode === "live"
          ? PAPER_PLANS.map((plan) => (
              <button
                key={plan}
                type="button"
                aria-pressed={livePlan === plan}
                onClick={() => setLivePlan(plan)}
                className={`min-h-11 rounded-md px-3 text-sm ${livePlan === plan ? "bg-brass text-on-brass" : "border border-rule bg-panel-2 text-ink"}`}
              >
                {paperLabel(plan)}
              </button>
            ))
          : PAPER_PLANS.map((plan) => (
              <button
                key={plan}
                type="button"
                aria-pressed={paperOn[plan]}
                onClick={() => setPaperOn(plan, !paperOn[plan])}
                className={`min-h-11 rounded-md px-3 text-sm ${paperOn[plan] ? "bg-brass text-on-brass" : "border border-rule bg-panel-2 text-ink"}`}
              >
                {paperLabel(plan)}
              </button>
            ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-mist">
        {mode === "live"
          ? "En réel, une seule stratégie à la fois : elles prendraient des côtés opposés avec le même argent."
          : "En papier, plusieurs stratégies tournent en même temps. Chacune garde son historique."}
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-4 min-h-11 text-sm text-mist underline-offset-4 hover:text-ink hover:underline"
      >
        Rendre les mises papier ouvertes
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

function shownEntry(entry: string | undefined, plan: PaperPlan): string | undefined {
  if (!entry) return entry;
  let base = entry;
  for (let i = 0; i < 3; i++) {
    const next = base.replace(/\s*·\s*(inversé|inverse|normal|direct|stop|double|paire)\s*$/i, "");
    if (next === base) break;
    base = next;
  }
  const tag = plan === "inverse" ? "inversé" : plan === "direct" ? "normal" : plan;
  base = base.trim();
  return base ? `${base} · ${tag}` : tag;
}

function planOfFill(fill: LiveFill): PaperPlan {
  if (fill.result === "stop") return "stop";
  if (fill.id.includes("-stop-")) return "stop";
  if (fill.id.includes("-double-") || fill.id.startsWith("pair-")) return "double";
  if (fill.id.includes("-inverse-")) return "inverse";
  if (fill.id.includes("-direct-")) return "direct";
  const text = (fill.entry ?? "").toLowerCase();
  if (text.includes("invers")) return "inverse";
  if (/(?:^|·|\s)stop(?:$|·|\s)/.test(text)) return "stop";
  if (text.includes("double") || text.includes("paire")) return "double";
  return fill.plan && fill.plan !== "direct" ? fill.plan : "direct";
}

function fillMoney(fill: LiveFill): number | null {
  if (fill.status !== "accepted" || !fill.result) return null;
  if (fill.result === "stop") return livePnl(fill);
  return settlementPnl(fill.stake, fill.ask, fill.result === "win");
}

function legsText(side: Side, ask: number, hedge?: { side: Side; ask: number } | null): string {
  if (!hedge) return `${side} ${formatCents(ask)}`;
  return `${side} ${formatCents(ask)} + ${hedge.side} ${formatCents(hedge.ask)}`;
}

function Journal({
  books,
  paperOn,
  liveFills,
  nowSec,
  mode,
}: {
  books: ReturnType<typeof useDesk.getState>["books"];
  paperOn: Record<PaperPlan, boolean>;
  liveFills: LiveFill[];
  nowSec: number;
  mode: "paper" | "live";
}) {
  const [view, setView] = useState<"paper" | "live">(mode);
  const [tab, setTab] = useState<PaperPlan>("direct");
  useEffect(() => setView(mode), [mode]);
  const stats = PAPER_PLANS.map((plan) => {
    if (view === "paper") {
      const book = books[plan];
      return { plan, pnl: book.cash - STARTING_CASH, count: book.trades.length, cash: book.cash };
    }
    const settled = liveFills.filter((fill) => planOfFill(fill) === plan && fillMoney(fill) != null);
    const pnl = settled.reduce((sum, fill) => sum + (fillMoney(fill) ?? 0), 0);
    return { plan, pnl, count: settled.length, cash: null as number | null };
  });
  return (
    <section className="mt-3 rounded-lg border border-rule bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">Historique</h2>
        <div className="flex gap-2">
          {(["paper", "live"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={view === item}
              onClick={() => setView(item)}
              className={`min-h-11 rounded-md px-3 text-sm ${view === item ? "bg-brass text-on-brass" : "border border-rule bg-panel-2 text-ink"}`}
            >
              {item === "paper" ? "Papier" : "Réel"}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <button
            key={stat.plan}
            type="button"
            aria-pressed={tab === stat.plan}
            onClick={() => setTab(stat.plan)}
            className={`rounded-md border px-3 py-2 text-left ${tab === stat.plan ? "border-brass bg-panel-2" : "border-rule"}`}
          >
            <p className="text-sm text-ink">
              {paperLabel(stat.plan)}
              {view === "paper" && !paperOn[stat.plan] ? " · pause" : ""}
            </p>
            <p className={`font-mono text-sm ${stat.pnl >= 0 ? "text-up" : "text-down"}`}>{formatSignedUsd(stat.pnl)}</p>
            <p className="font-mono text-xs text-mist">
              {stat.count} trade{stat.count > 1 ? "s" : ""}
              {stat.cash != null ? ` · ${formatUsd(stat.cash, 0)}` : ""}
            </p>
          </button>
        ))}
      </div>
      {view === "paper" ? <BookCurve book={books[tab]} plan={tab} /> : null}
      {view === "paper" ? (
        <PaperList book={books[tab]} plan={tab} />
      ) : (
        <LiveList fills={liveFills.filter((fill) => planOfFill(fill) === tab)} nowSec={nowSec} />
      )}
    </section>
  );
}

function bookSeries(book: { cash: number; trades: PaperTrade[]; open: OpenPosition | null }) {
  const trades = [...book.trades].sort((a, b) => a.openedAt - b.openedAt);
  const now = Date.now();
  const points: { t: number; value: number }[] = [];
  let value = STARTING_CASH;
  const opened = trades[0]?.openedAt ?? book.open?.openedAt ?? now - 60 * 60_000;
  points.push({ t: opened - 60_000, value: STARTING_CASH });
  for (const trade of trades) {
    value += trade.pnl;
    points.push({
      t: Math.max(trade.openedAt, points[points.length - 1].t + 1),
      value: Math.round(value * 100) / 100,
    });
  }
  points.push({
    t: Math.max(now, points[points.length - 1].t + 1),
    value: Math.round(book.cash * 100) / 100,
  });
  return points;
}

function BookCurve({
  book,
  plan,
}: {
  book: { cash: number; trades: PaperTrade[]; open: OpenPosition | null };
  plan: PaperPlan;
}) {
  const points = bookSeries(book);
  const first = points[0]?.value ?? STARTING_CASH;
  const last = points[points.length - 1]?.value ?? book.cash;
  const change = last - first;
  const values = points.map((point) => point.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = hi - lo < 0.5 ? 1 : Math.max(0.25, (hi - lo) * 0.12);
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-ink">Valeur · {paperLabel(plan)}</p>
        <p className={`font-mono text-sm ${change >= 0 ? "text-up" : "text-down"}`}>{formatUsd(last, 2)}</p>
      </div>
      <div className="mt-2 h-36">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t: number) =>
                new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
              }
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
            <ReferenceLine y={STARTING_CASH} stroke="var(--color-rule)" strokeDasharray="3 3" />
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
      </div>
    </div>
  );
}

function PaperList({
  book,
  plan,
}: {
  book: { cash: number; trades: PaperTrade[]; open: OpenPosition | null };
  plan: PaperPlan;
}) {
  if (book.open == null && book.trades.length === 0) {
    return <p className="mt-4 text-sm text-mist">Aucun trade {paperLabel(plan)} pour l'instant.</p>;
  }
  return (
    <ul className="mt-3 divide-y divide-rule">
      {book.open ? (
        <li className="flex flex-wrap items-baseline justify-between gap-2 py-3">
          <div>
            <p className="text-sm text-ink">
              {legsText(book.open.side, book.open.ask, book.open.hedge)}
              {plan === "double" && !book.open.hedge ? " · autre côté pas encore" : ""}
            </p>
            <p className="font-mono text-xs text-mist">{formatTime(book.open.openedAt)}</p>
            {book.open.entry ? <p className="font-mono text-xs text-mist">{shownEntry(book.open.entry, plan)}</p> : null}
          </div>
          <p className="font-mono text-sm text-mist">{book.open.hedge ? "deux côtés" : "en cours"}</p>
        </li>
      ) : null}
      {book.trades.map((trade) => (
        <li key={trade.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
          <div>
            <p className="text-sm text-ink">
              {legsText(trade.side, trade.ask, trade.hedge)}
              {plan === "double" && !trade.hedge ? " · un seul côté" : ""} ·{" "}
              {trade.exit === "stop"
                ? "stop"
                : trade.status === "void"
                  ? "fenêtre manquée"
                  : trade.hedge
                    ? trade.status === "win"
                      ? "double gagné"
                      : "double perdu"
                    : trade.status === "win"
                      ? "gagné"
                      : "perdu"}
            </p>
            <p className="font-mono text-xs text-mist">{formatTime(trade.openedAt)}</p>
            {trade.entry ? <p className="font-mono text-xs text-mist">{shownEntry(trade.entry, plan)}</p> : null}
          </div>
          <p className={`font-mono text-sm ${trade.pnl > 0 ? "text-up" : trade.pnl < 0 ? "text-down" : "text-mist"}`}>
            {formatSignedUsd(trade.pnl)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function LiveList({ fills, nowSec }: { fills: LiveFill[]; nowSec: number }) {
  const rows = groupLive(fills);
  if (rows.length === 0) return <p className="mt-4 text-sm text-mist">Aucun ordre réel pour cette stratégie.</p>;
  return (
    <ul className="mt-3 divide-y divide-rule">
      {rows.map((row) => {
        const first = row[0];
        const pending = row.some((fill) => fill.status === "accepted" && !fill.result);
        const live = pending && nowSec < first.windowStart + 300;
        const rejected = row.every((fill) => fill.status === "rejected" || fill.status === "retrying");
        const pnl = row.reduce((sum, fill) => {
          const money = fillMoney(fill);
          return money == null ? sum : sum + money;
        }, 0);
        const known = row.some((fill) => fillMoney(fill) != null);
        const title =
          row.length > 1
            ? row.map((fill) => `${fill.side} ${formatCents(fill.ask)}`).join(" + ")
            : `${first.side} ${formatCents(first.ask)}${planOfFill(first) === "double" && first.status === "accepted" ? " · autre côté pas encore" : ""}`;
        const state = rejected
          ? first.status === "retrying"
            ? "essai"
            : "refusé"
          : row.some((fill) => fill.result === "stop")
            ? "stop"
            : pending
              ? live
                ? "en cours"
                : "en attente"
              : known && pnl >= 0
                ? "gagné"
                : "perdu";
        return (
          <li key={row.map((fill) => fill.id).join("-")} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
            <div>
              <p className="text-sm text-ink">
                {title} · {row.map((fill) => formatUsd(fill.stake, 0)).join(" + ")} · {state}
              </p>
              <p className="font-mono text-xs text-mist">
                {formatTime(first.openedAt)} · {row.map((fill) => fill.detail).join(" · ")}
              </p>
              {first.entry ? <p className="font-mono text-xs text-mist">{shownEntry(first.entry, planOfFill(first))}</p> : null}
            </div>
            <p className={`font-mono text-sm ${known && pnl > 0 ? "text-up" : known && pnl < 0 ? "text-down" : "text-mist"}`}>
              {known ? formatSignedUsd(pnl) : rejected ? "échec" : "…"}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function groupLive(fills: LiveFill[]): LiveFill[][] {
  const rows: LiveFill[][] = [];
  const used = new Set<string>();
  for (const fill of fills) {
    if (used.has(fill.id)) continue;
    if (planOfFill(fill) === "double" && fill.status === "accepted") {
      const mates = fills.filter(
        (other) => other.windowStart === fill.windowStart && other.status === "accepted" && planOfFill(other) === "double",
      );
      if (mates.length > 1) {
        for (const mate of mates) used.add(mate.id);
        rows.push(mates.sort((a, b) => a.openedAt - b.openedAt));
        continue;
      }
    }
    used.add(fill.id);
    rows.push([fill]);
  }
  return rows;
}
