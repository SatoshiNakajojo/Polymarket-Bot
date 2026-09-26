import { i as __toESM } from "../_runtime.mjs";
import { a as takerFeePerShare, i as sideEv, n as decide, r as fairUp, t as MAX_SPREAD } from "./engine-DkAqhIrm.mjs";
import { b as require_jsx_runtime, q as require_react } from "../_libs/@tanstack/react-router+[...].mjs";
import { n as TSS_SERVER_FUNCTION, r as getServerFnById, t as createServerFn } from "./ssr.mjs";
import { a as ResponsiveContainer, i as ReferenceLine, n as YAxis, r as Area, t as AreaChart } from "../_libs/recharts+[...].mjs";
import { n as create, t as persist } from "../_libs/zustand.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-C-6ILrfJ.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
function formatUsd(n, digits = 2) {
	return `${new Intl.NumberFormat("fr-FR", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(n)} $`;
}
function formatPlain(n, digits = 1) {
	return new Intl.NumberFormat("fr-FR", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(n);
}
function formatProb(p) {
	return new Intl.NumberFormat("fr-FR", {
		style: "percent",
		minimumFractionDigits: 1,
		maximumFractionDigits: 1
	}).format(p);
}
function formatCents(price) {
	return `${formatPlain(price * 100, 1)} c`;
}
function formatSignedUsd(n) {
	const body = formatUsd(Math.abs(n), 2);
	if (n > 0) return `+${body}`;
	if (n < 0) return `−${body}`;
	return formatUsd(0, 2);
}
function formatClock(sec) {
	const s = Math.max(0, Math.floor(sec));
	const m = Math.floor(s / 60);
	const r = s % 60;
	return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
function formatTime(ms) {
	return new Intl.DateTimeFormat("fr-FR", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit"
	}).format(ms);
}
var createSsrRpc = (functionId) => {
	const url = "/_serverFn/" + functionId;
	const serverFnMeta = { id: functionId };
	const fn = async (...args) => {
		return (await getServerFnById(functionId, { origin: "server" }))(...args);
	};
	return Object.assign(fn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
var getMarketSnapshot = createServerFn({ method: "GET" }).handler(createSsrRpc("935ab48d8718b307a4bbd5fa411dc60a4cc004a3d19d36a4a1964d5d5bdbed99"));
var STARTING_CASH = 1e3;
var defaults = {
	cash: STARTING_CASH,
	trades: [],
	open: null,
	enteredWindow: null,
	armed: true,
	stakeUsd: 10,
	minEdge: .03,
	lossCap: 80
};
var useDesk = create()(persist((set, get) => ({
	hydrated: false,
	...defaults,
	setHydrated: () => set({ hydrated: true }),
	setArmed: (armed) => set({ armed }),
	setStakeUsd: (stakeUsd) => set({ stakeUsd }),
	setMinEdge: (minEdge) => set({ minEdge }),
	setLossCap: (lossCap) => set({ lossCap }),
	enter: (position) => {
		const state = get();
		if (state.open || state.enteredWindow === position.windowStart) return;
		if (position.cost > state.cash) return;
		set({
			open: position,
			enteredWindow: position.windowStart,
			cash: state.cash - position.cost
		});
	},
	settle: (windowStart, outcome, twap) => {
		const state = get();
		const open = state.open;
		if (!open || open.windowStart !== windowStart) return;
		const win = open.side === outcome;
		const payout = win ? open.shares : 0;
		const pnl = payout - open.cost;
		const trade = {
			...open,
			status: win ? "win" : "loss",
			pnl,
			outcome,
			settleTwap: twap
		};
		set({
			open: null,
			cash: state.cash + payout,
			trades: [trade, ...state.trades].slice(0, 40)
		});
	},
	voidOpen: (windowStart) => {
		const state = get();
		const open = state.open;
		if (!open || open.windowStart !== windowStart) return;
		const trade = {
			...open,
			status: "void",
			pnl: 0,
			outcome: null,
			settleTwap: null
		};
		set({
			open: null,
			cash: state.cash + open.cost,
			trades: [trade, ...state.trades].slice(0, 40)
		});
	},
	reset: () => set({
		...defaults,
		armed: get().armed,
		stakeUsd: get().stakeUsd,
		minEdge: get().minEdge,
		lossCap: get().lossCap
	})
}), {
	name: "fenetre-paper-v1",
	skipHydration: true,
	partialize: (state) => ({
		cash: state.cash,
		trades: state.trades,
		open: state.open,
		enteredWindow: state.enteredWindow,
		armed: state.armed,
		stakeUsd: state.stakeUsd,
		minEdge: state.minEdge,
		lossCap: state.lossCap
	})
}));
function useNowSec(serverNow) {
	const offset = (0, import_react.useRef)(0);
	const lastServer = (0, import_react.useRef)(null);
	const [now, setNow] = (0, import_react.useState)(() => Date.now());
	if (serverNow != null && lastServer.current !== serverNow) {
		lastServer.current = serverNow;
		offset.current = serverNow * 1e3 - Date.now();
	}
	(0, import_react.useEffect)(() => {
		const id = window.setInterval(() => setNow(Date.now()), 500);
		return () => window.clearInterval(id);
	}, []);
	return (now + offset.current) / 1e3;
}
function Desk() {
	const [snap, setSnap] = (0, import_react.useState)(null);
	const [failed, setFailed] = (0, import_react.useState)(null);
	const armed = useDesk((s) => s.armed);
	const stakeUsd = useDesk((s) => s.stakeUsd);
	const minEdge = useDesk((s) => s.minEdge);
	const lossCap = useDesk((s) => s.lossCap);
	const cash = useDesk((s) => s.cash);
	const trades = useDesk((s) => s.trades);
	const open = useDesk((s) => s.open);
	const hydrated = useDesk((s) => s.hydrated);
	(0, import_react.useEffect)(() => {
		const pending = useDesk.persist.rehydrate();
		if (pending instanceof Promise) pending.then(() => useDesk.getState().setHydrated());
		else useDesk.getState().setHydrated();
	}, []);
	(0, import_react.useEffect)(() => {
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
		pull();
		const id = window.setInterval(() => void pull(), 2e3);
		return () => {
			stop = true;
			window.clearInterval(id);
		};
	}, []);
	const nowSec = useNowSec(snap?.serverNow ?? null);
	(0, import_react.useEffect)(() => {
		if (!snap || !snap.ok || !hydrated) return;
		const state = useDesk.getState();
		if (state.open && snap.previous.complete && state.open.windowStart === snap.previous.start) {
			const outcome = snap.previous.twap >= snap.previous.strike ? "Up" : "Down";
			state.settle(state.open.windowStart, outcome, snap.previous.twap);
		} else if (state.open && state.open.windowStart < snap.live.start - 300) state.voidOpen(state.open.windowStart);
		const fresh = useDesk.getState();
		const lossHalted = fresh.cash - STARTING_CASH <= -fresh.lossCap;
		const fair = fairUp({
			strike: snap.live.strike,
			twap: snap.live.twap,
			price: snap.price,
			elapsedSec: Math.max(0, nowSec - snap.live.start),
			remainingSec: Math.max(0, snap.live.end - nowSec),
			sigmaPerSqrtSec: snap.sigmaPerSqrtSec
		});
		const market = snap.market;
		const decision = decide({
			remainingSec: Math.max(0, snap.live.end - nowSec),
			pUp: fair.pUp,
			up: market?.up ?? {
				bid: null,
				ask: null,
				askSize: null
			},
			down: market?.down ?? {
				bid: null,
				ask: null,
				askSize: null
			},
			stakeUsd: fresh.stakeUsd,
			minOrderSize: snap.minOrderSize,
			feeRate: snap.feeRate,
			minEdge: fresh.minEdge,
			minRemaining: 20,
			maxRemaining: 110,
			maxSpread: MAX_SPREAD,
			lossHalted,
			alreadyIn: fresh.open != null || fresh.enteredWindow === snap.live.start,
			armed: fresh.armed,
			marketState: !market ? "missing" : market.acceptingOrders ? "ready" : "closed",
			cash: fresh.cash
		});
		if (decision.action === "buy" && decision.side && decision.ask != null && decision.shares != null && decision.cost != null && decision.fee != null && decision.ev != null) {
			const position = {
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
				strike: snap.live.strike
			};
			fresh.enter(position);
		}
	}, [
		snap,
		hydrated,
		armed,
		stakeUsd,
		minEdge,
		lossCap,
		nowSec
	]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "mx-auto min-h-screen w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Header, {
				cash,
				armed,
				pnl: cash - STARTING_CASH
			}),
			!snap && !failed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-10 text-sm text-mist",
				children: "Lecture du carnet Polymarket et du BTC…"
			}) : null,
			failed && (!snap || !snap.ok) ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
				className: "mt-6 max-w-xl text-sm text-down",
				role: "alert",
				children: [failed, " Nouvelle tentative dans un instant."]
			}) : null,
			snap?.ok ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Live, {
				snap,
				nowSec
			}) : null,
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Journal, {
				trades,
				open
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-6 max-w-3xl text-xs leading-relaxed text-mist",
				children: "Papier uniquement. Le règlement simulé compare le TWAP Coinbase de la fenêtre au prix d'ouverture. Polymarket, lui, règle sur le TWAP Chainlink BTC/USD — ce n'est pas le même oracle. Aucune clé, aucun ordre réel."
			})
		]
	});
}
function Header({ cash, armed, pnl }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
		className: "flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "font-mono text-xs tracking-widest text-brass",
				children: "BTC · 5 MIN · POLYMARKET"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "mt-1 text-3xl font-semibold tracking-tight text-ink",
				children: "Fenêtre"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-1 text-sm text-mist",
				children: "Up ou Down, une fenêtre à la fois. Encaisse fictive."
			})
		] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-wrap items-center gap-3",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
				className: "inline-flex items-center gap-2 rounded-full border border-rule px-3 py-1 font-mono text-xs text-mist",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `size-1.5 rounded-full bg-brass ${armed ? "fenetre-live" : "opacity-40"}` }), armed ? "BOT PAPIER ARMÉ" : "BOT EN VEILLE"]
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "text-right",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "font-mono text-lg text-ink",
					children: formatUsd(cash, 2)
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
					className: `font-mono text-xs ${pnl >= 0 ? "text-up" : "text-down"}`,
					children: ["session ", formatSignedUsd(pnl)]
				})]
			})]
		})]
	});
}
function Live({ snap, nowSec }) {
	const remaining = Math.max(0, snap.live.end - nowSec);
	const elapsed = Math.min(300, Math.max(0, nowSec - snap.live.start));
	const fair = fairUp({
		strike: snap.live.strike,
		twap: snap.live.twap,
		price: snap.price,
		elapsedSec: elapsed,
		remainingSec: remaining,
		sigmaPerSqrtSec: snap.sigmaPerSqrtSec
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
		up: market?.up ?? {
			bid: null,
			ask: null,
			askSize: null
		},
		down: market?.down ?? {
			bid: null,
			ask: null,
			askSize: null
		},
		stakeUsd,
		minOrderSize: snap.minOrderSize,
		feeRate: snap.feeRate,
		minEdge,
		minRemaining: 20,
		maxRemaining: 110,
		maxSpread: MAX_SPREAD,
		lossHalted,
		alreadyIn: open != null || enteredWindow === snap.live.start,
		armed,
		marketState: !market ? "missing" : market.acceptingOrders ? "ready" : "closed",
		cash
	});
	const delta = snap.price - snap.live.strike;
	const bps = snap.live.strike > 0 ? delta / snap.live.strike * 1e4 : 0;
	const progress = Math.min(100, Math.max(0, elapsed / 300 * 100));
	const chart = (0, import_react.useMemo)(() => {
		const points = snap.live.path.map((point) => ({
			t: point.t,
			price: point.price
		}));
		if (points.length === 1) {
			const only = points[0];
			if (only) points.unshift({
				t: snap.live.start,
				price: only.price
			});
		}
		return points;
	}, [snap.live.path, snap.live.start]);
	const prices = chart.map((p) => p.price);
	const lo = Math.min(snap.live.strike, ...prices);
	const hi = Math.max(snap.live.strike, ...prices);
	const pad = Math.max(8, (hi - lo) * .25);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-5 grid gap-4 lg:grid-cols-12",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
			className: "rounded-lg border border-rule bg-panel p-4 lg:col-span-7",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-start justify-between gap-4",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "font-mono text-xs text-mist",
						children: "fenêtre en cours"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-1 font-mono text-5xl font-medium tracking-tight text-ink",
						children: formatClock(remaining)
					})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "text-right",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "font-mono text-xs text-mist",
								children: "BTC"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "font-mono text-2xl text-ink",
								children: formatUsd(snap.price, 2)
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
								className: `font-mono text-xs ${delta >= 0 ? "text-up" : "text-down"}`,
								children: [
									delta >= 0 ? "+" : "−",
									formatUsd(Math.abs(delta), 2),
									" · ",
									formatPlain(bps, 1),
									" bps"
								]
							})
						]
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-4 h-1 w-full overflow-hidden rounded-full bg-panel-2",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "h-full bg-brass",
						style: { width: `${progress}%` }
					})
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
					className: "mt-4 grid grid-cols-3 gap-3",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
							label: "Ouverture",
							value: formatUsd(snap.live.strike, 2)
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
							label: "TWAP",
							value: formatUsd(snap.live.twap, 2)
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
							label: "Modèle Up",
							value: formatProb(fair.pUp)
						})
					]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-4 h-44",
					children: chart.length > 1 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResponsiveContainer, {
						width: "100%",
						height: "100%",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(AreaChart, {
							data: chart,
							margin: {
								top: 8,
								right: 4,
								left: 0,
								bottom: 0
							},
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(YAxis, {
									hide: true,
									domain: [lo - pad, hi + pad]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ReferenceLine, {
									y: snap.live.strike,
									stroke: "var(--color-brass)",
									strokeDasharray: "4 4"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Area, {
									type: "monotone",
									dataKey: "price",
									stroke: "var(--color-ink)",
									fill: "var(--color-panel-2)",
									strokeWidth: 1.75,
									dot: false,
									isAnimationActive: false
								})
							]
						})
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "text-sm text-mist",
						children: "Courbe en attente du premier échantillon."
					})
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
					className: "mt-2 text-xs text-mist",
					children: [
						market?.title ?? "Slug en attente",
						" · vol ~",
						" ",
						formatUsd(snap.sigmaPerSqrtSec * Math.sqrt(60), 0),
						" / min · frais taker",
						" ",
						formatPlain(snap.feeRate * 100, 1),
						" % × p × (1−p)"
					]
				})
			]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
			className: "flex flex-col gap-4 lg:col-span-5",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "grid grid-cols-2 gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(QuoteCard, {
						side: "Up",
						quote: market?.up ?? null,
						prob: fair.pUp,
						feeRate: snap.feeRate,
						hot: decision.side === "Up"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(QuoteCard, {
						side: "Down",
						quote: market?.down ?? null,
						prob: 1 - fair.pUp,
						feeRate: snap.feeRate,
						hot: decision.side === "Down"
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: `rounded-lg border bg-panel p-4 ${decision.action === "buy" ? decision.side === "Down" ? "border-down" : "border-up" : "border-rule"}`,
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "font-mono text-xs text-mist",
							children: "décision"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-1 text-2xl font-semibold text-ink",
							children: decision.action === "buy" ? `Acheter ${decision.side === "Up" ? "Up" : "Down"}` : "Attendre"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-2 text-sm leading-relaxed text-mist",
							children: decision.reason
						}),
						open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "mt-3 font-mono text-xs text-ink",
							children: [
								"Position ",
								open.side,
								" · ",
								formatPlain(open.shares, 2),
								" parts @ ",
								formatCents(open.ask),
								" · coût",
								" ",
								formatUsd(open.cost, 2)
							]
						}) : null,
						market ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							className: "mt-3 inline-flex min-h-11 items-center text-sm text-brass underline-offset-4 hover:underline",
							href: `https://polymarket.com/event/${market.slug}`,
							target: "_blank",
							rel: "noreferrer",
							children: "Voir le marché sur Polymarket"
						}) : null
					]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Controls, {})
			]
		})]
	});
}
function Stat({ label, value }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
		className: "text-xs text-mist",
		children: label
	}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
		className: "mt-1 font-mono text-sm text-ink",
		children: value
	})] });
}
function QuoteCard({ side, quote, prob, feeRate, hot }) {
	const ask = quote?.ask ?? null;
	const ev = ask == null ? null : sideEv(prob, ask, feeRate);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", {
		className: `rounded-lg border bg-panel p-3 ${hot ? "border-brass" : "border-rule"}`,
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: `font-mono text-xs tracking-widest ${side === "Up" ? "text-up" : "text-down"}`,
				children: side === "Up" ? "UP" : "DOWN"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-2 font-mono text-2xl text-ink",
				children: ask == null ? "—" : formatCents(ask)
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
				className: "mt-2 text-xs text-mist",
				children: ["modèle ", formatProb(prob)]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: `mt-1 font-mono text-xs ${ev != null && ev >= 0 ? "text-brass" : "text-down"}`,
				children: ev == null ? "pas d'ask" : `écart ${formatSignedEdge(ev)}`
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-2 text-xs text-mist",
				children: quote?.askSize != null ? `${formatPlain(quote.askSize, 0)} parts au meilleur ask` : "profondeur inconnue"
			})
		]
	});
}
function formatSignedEdge(ev) {
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
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
		className: "rounded-lg border border-rule bg-panel p-4",
		onSubmit: (event) => event.preventDefault(),
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm font-medium text-ink",
					children: "Bot papier"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
					className: "text-xs text-mist",
					children: [
						"Entre seulement entre ",
						110,
						"s et ",
						20,
						"s."
					]
				})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					"aria-pressed": armed,
					onClick: () => setArmed(!armed),
					className: `min-h-11 rounded-md px-4 text-sm font-medium ${armed ? "bg-brass text-on-brass" : "border border-rule bg-panel-2 text-ink"}`,
					children: armed ? "Armé" : "Armer"
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "Mise $",
						value: stakeUsd,
						min: 1,
						max: 200,
						step: 1,
						onChange: (n) => setStakeUsd(clampField(n, 1, 200, 10))
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "Écart min c",
						value: Math.round(minEdge * 100),
						min: 1,
						max: 20,
						step: 1,
						onChange: (n) => setMinEdge(clampField(n, 1, 20, 3) / 100)
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "Perte max $",
						value: lossCap,
						min: 10,
						max: 500,
						step: 10,
						onChange: (n) => setLossCap(clampField(n, 10, 500, 80))
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
				type: "button",
				onClick: () => reset(),
				className: "mt-4 min-h-11 text-sm text-mist underline-offset-4 hover:text-ink hover:underline",
				children: ["Remettre l'encaisse à ", formatUsd(STARTING_CASH, 0)]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
				className: "mt-2 text-xs leading-relaxed text-mist",
				children: [
					"Frais estimés ",
					formatCents(takerFeePerShare(.5)),
					" par part à 50 c. Taille mini du carnet : 5 parts."
				]
			})
		]
	});
}
function clampField(n, min, max, fallback) {
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}
function Field({ label, value, min, max, step, onChange }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
		className: "block",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "text-xs text-mist",
			children: label
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
			className: "mt-1 h-11 w-full rounded-md border border-rule bg-panel-2 px-2 font-mono text-sm text-ink",
			type: "number",
			inputMode: "decimal",
			min,
			max,
			step,
			value,
			onChange: (event) => onChange(Number(event.target.value))
		})]
	});
}
function Journal({ trades, open }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
		className: "mt-4 rounded-lg border border-rule bg-panel p-4",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
			className: "text-sm font-medium text-ink",
			children: "Journal"
		}), open == null && trades.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "mt-3 text-sm text-mist",
			children: "Aucun trade. Le bot n'achète que si le modèle bat l'ask, frais compris, et que le prix s'est déjà éloigné de l'ouverture."
		}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("ul", {
			className: "mt-3 divide-y divide-rule",
			children: [open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
				className: "flex flex-wrap items-baseline justify-between gap-2 py-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
					className: "text-sm text-ink",
					children: [
						open.side,
						" ouvert · ",
						formatCents(open.ask),
						" · modèle ",
						formatProb(open.pModel)
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "font-mono text-xs text-mist",
					children: formatTime(open.openedAt)
				})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "font-mono text-sm text-mist",
					children: "en cours"
				})]
			}) : null, trades.map((trade) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
				className: "flex flex-wrap items-baseline justify-between gap-2 py-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
					className: "text-sm text-ink",
					children: [
						trade.side,
						" · ",
						formatCents(trade.ask),
						" ·",
						" ",
						trade.status === "void" ? "fenêtre manquée, mise rendue" : trade.status === "win" ? "gagné" : "perdu"
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "font-mono text-xs text-mist",
					children: formatTime(trade.openedAt)
				})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: `font-mono text-sm ${trade.pnl > 0 ? "text-up" : trade.pnl < 0 ? "text-down" : "text-mist"}`,
					children: formatSignedUsd(trade.pnl)
				})]
			}, trade.id))]
		})]
	});
}
function Home() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Desk, {});
}
//#endregion
export { Home as component };
