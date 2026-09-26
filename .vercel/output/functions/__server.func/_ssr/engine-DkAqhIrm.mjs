//#region node_modules/.nitro/vite/services/ssr/assets/engine-DkAqhIrm.js
var FEE_RATE = .07;
var MAX_SPREAD = .08;
function windowStartSec(nowSec) {
	return Math.floor(nowSec / 300) * 300;
}
function clamp(n, min, max) {
	return Math.min(max, Math.max(min, n));
}
/** Abramowitz & Stegun 7.1.26, max error ~1.5e-7. */
function normalCdf(x) {
	if (x < -8) return 0;
	if (x > 8) return 1;
	const sign = x < 0 ? -1 : 1;
	const ax = Math.abs(x);
	const a1 = .254829592;
	const a2 = -.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const t = 1 / (1 + .3275911 * (ax / Math.SQRT2));
	return .5 * (1 + sign * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-(ax / Math.SQRT2) * (ax / Math.SQRT2))));
}
function takerFeePerShare(price, rate = FEE_RATE) {
	const p = clamp(price, 0, 1);
	return rate * p * (1 - p);
}
/**
* P(Up) that the window TWAP finishes at or above the opening price.
* Remaining path is a driftless random walk; the uncertainty is on the
* average of what's left, not on a single end print.
*/
function fairUp(input) {
	const elapsed = Math.max(0, input.elapsedSec);
	const remaining = Math.max(0, input.remainingSec);
	const total = elapsed + remaining;
	if (!(input.strike > 0) || !(input.price > 0) || total <= 0) return {
		pUp: .5,
		breakeven: input.strike,
		z: 0
	};
	if (remaining < 1) {
		const up = input.twap >= input.strike;
		return {
			pUp: up ? .985 : .015,
			breakeven: input.price,
			z: up ? 3 : -3
		};
	}
	const locked = input.twap * elapsed;
	const breakeven = (input.strike * total - locked) / remaining;
	const std = Math.max(.5, input.sigmaPerSqrtSec * Math.sqrt(remaining / 3));
	const z = clamp((input.price - breakeven) / std, -6, 6);
	return {
		pUp: normalCdf(z),
		breakeven,
		z
	};
}
function cents(x) {
	const v = Math.round(x * 100);
	return `${v > 0 ? "+" : ""}${v} c`;
}
function sideEv(prob, ask, feeRate) {
	return prob - ask - takerFeePerShare(ask, feeRate);
}
function bookProblem(up, down, maxSpread) {
	if (up.ask == null || down.ask == null || up.bid == null || down.bid == null) return "Carnet incomplet — pas d'achat.";
	if (up.ask - up.bid > maxSpread || down.ask - down.bid > maxSpread) return "Spread trop large — le carnet est illisible.";
	if (Math.abs(up.ask + down.bid - 1) > .05 || Math.abs(down.ask + up.bid - 1) > .05) return "Carnet incohérent avec son complément — on passe.";
	return null;
}
function decide(input) {
	const wait = (reason) => ({
		action: "wait",
		side: null,
		ask: null,
		shares: null,
		cost: null,
		fee: null,
		ev: null,
		reason
	});
	if (!input.armed) return wait("Bot en veille. Arme-le pour paper-trader.");
	if (input.marketState === "missing") return wait("Marché 5 min introuvable sur Polymarket.");
	if (input.marketState === "closed") return wait("Le carnet n'accepte plus d'ordres sur cette fenêtre.");
	if (input.lossHalted) return wait("Plafond de perte atteint. Réinitialise l'encaisse ou relève le plafond.");
	if (input.alreadyIn) return wait("Déjà engagé sur cette fenêtre. On tient jusqu'au règlement.");
	if (input.remainingSec > input.maxRemaining) return wait("Trop tôt. Le TWAP de la fenêtre n'est pas encore informatif.");
	if (input.remainingSec < input.minRemaining) return wait("Trop tard pour entrer. On laisse filer la fin de fenêtre.");
	const broken = bookProblem(input.up, input.down, input.maxSpread);
	if (broken) return wait(broken);
	const upAsk = input.up.ask;
	const downAsk = input.down.ask;
	const evUp = sideEv(input.pUp, upAsk, input.feeRate);
	const evDown = sideEv(1 - input.pUp, downAsk, input.feeRate);
	const pickUp = evUp >= evDown;
	const side = pickUp ? "Up" : "Down";
	const ev = pickUp ? evUp : evDown;
	const ask = pickUp ? upAsk : downAsk;
	const label = side === "Up" ? "Up" : "Down";
	if (ev < input.minEdge) return wait(`${label} à ${cents(ask).replace("+", "")}, écart ${cents(ev)} après frais — sous le seuil de ${cents(input.minEdge)}.`);
	const shares = Math.floor(input.stakeUsd / ask * 100) / 100;
	const fee = shares * takerFeePerShare(ask, input.feeRate);
	const cost = shares * ask + fee;
	if (!(shares >= input.minOrderSize)) return wait(`Mise trop petite : ${shares.toFixed(2)} parts, minimum du carnet ${input.minOrderSize}.`);
	if (cost > input.cash + 1e-9) return wait("Encaisse papier insuffisante pour cette mise.");
	return {
		action: "buy",
		side,
		ask,
		shares,
		cost,
		fee,
		ev,
		reason: `Achat papier ${label} · écart ${cents(ev)} après frais taker.`
	};
}
//#endregion
export { takerFeePerShare as a, sideEv as i, decide as n, windowStartSec as o, fairUp as r, MAX_SPREAD as t };
