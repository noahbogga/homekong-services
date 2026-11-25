// deriveMarkets.js — shared Poisson-derived markets for ANY soccer event that has a
// valid 1X2 (home/draw/away). Used by BOTH the ZQ pipeline (zqBettable.js) and the
// SharpAPI pipeline (crons/odds.js) so every football match offers the same set:
//   ah           : true 2-way Asian Handicap (half-ball, push-refund)
//   totals       : Over/Under total goals — 3-line ladder [skipped if feed has real line]
//   btts         : Both Teams To Score (Yes/No)
//   dc           : Double Chance (1X/12/X2)
//   dnb          : Draw No Bet
//   correct_score: exact scoreline (0-0 through 4-4), overround 1.20
//   goals        : Over/Under ladder at 0.5/1.5/2.5/3.5/4.5 lines
//
// Input probs must be fair (vig already stripped). Returns a plain object of market
// arrays to Object.assign onto event.markets. Also returns the fitted Poisson means
// (_lH/_lA) so callers can re-price totals later with an AI totals_shift.
const ahModel = require('./ahModel')

// Vig-stripped probabilities from three decimal 1X2 odds, or null if incomplete.
function fairProbs(w, d, l) {
  const o = [parseFloat(w), parseFloat(d), parseFloat(l)]
  if (o.some(x => !x || x < 1.01)) return null
  const inv = o.map(x => 1 / x)
  const sum = inv.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return null
  return { h: inv[0] / sum, d: inv[1] / sum, a: inv[2] / sum }
}

// fp: {h,d,a} fair probs. names: {home, away}. overrounds for AH vs the O/U/BTTS/DC/DNB
// family. hasTotals: skip building totals if the feed already supplied a real line.
// csOverround: higher margin for correct score (more outcomes, more variance).
// Returns { markets: {...}, lH, lA } or { markets: {}, lH: null, lA: null } if unfittable.
function deriveFromFair(fp, names, { ahOverround = 1.07, derivedOverround = 1.07, csOverround = 1.20, hasTotals = false } = {}) {
  const markets = {}
  if (!fp) return { markets, lH: null, lA: null }

  const fit = ahModel.fitPoisson(fp.h, fp.d, fp.a)
  if (!(fit.lH > 0 && fit.lA > 0)) return { markets, lH: null, lA: null }
  const lH = fit.lH, lA = fit.lA

  // Asian Handicap LADDER: like a real book, offer several selectable lines around the
  // balanced line (center ±1 in half-ball steps → up to 5 lines). Flatten the ladder to
  // a single outcome array; each outcome carries its OWN signed `point` (for settlement)
  // plus the shared home `line` (for grouping in the UI). Falls back to the single main
  // line if the ladder can't be built.
  const ladder = ahModel.buildAhLadder(lH, lA, ahOverround, names, 1, 0.5)
  if (ladder && ladder.length) {
    const flat = []
    for (const rung of ladder) {
      flat.push({ ...rung.home, line: rung.line })
      flat.push({ ...rung.away, line: rung.line })
    }
    markets.ah = flat
  } else {
    const ah = ahModel.buildAsianHandicap(fp.h, fp.d, fp.a, ahOverround, names, 0.5)
    if (ah) markets.ah = ah
  }

  if (!hasTotals) {
    // Totals LADDER: main line ±1 goal (3 lines, e.g. 1.5 / 2.5 / 3.5). Each Over/Under
    // pair shares the same `point`, so settlement (which reads handicap_line) is unchanged.
    const mainLine = ahModel.mainTotalLine(lH, lA)
    const totFlat = []
    for (const l of [mainLine - 1, mainLine, mainLine + 1]) {
      if (l < 0.5) continue
      const tot = ahModel.buildOverUnder(lH, lA, derivedOverround, l, 0)
      if (tot) totFlat.push(...tot)
    }
    if (totFlat.length) markets.totals = totFlat
  }

  const btts = ahModel.buildBTTS(lH, lA, derivedOverround)
  if (btts) markets.btts = btts

  const dc = ahModel.buildDoubleChance(fp.h, fp.d, fp.a, derivedOverround, names)
  if (dc) markets.dc = dc

  const dnb = ahModel.buildDrawNoBet(fp.h, fp.d, fp.a, derivedOverround, names)
  if (dnb) markets.dnb = dnb

  // Correct Score: full scoreline grid (0-0 through 4-4) with 1.20 overround.
  // Any result not listed just loses — no "Other" bucket.
  const cs = ahModel.buildCorrectScore(lH, lA, csOverround, 4)
  if (cs && cs.length) markets.correct_score = cs

  // Goals ladder: Over/Under at 0.5 / 1.5 / 2.5 / 3.5 / 4.5 (skips trivial lines).
  // Settles identically to totals (over/under a handicap_line).
  const goals = ahModel.buildGoalsLadder(lH, lA, derivedOverround)
  if (goals && goals.length) markets.goals = goals

  // HT/FT and half-time lines are built but NOT wired here yet —
  // settlement needs a half-time score source first. Add when ZQ HT data confirmed.

  return { markets, lH, lA }
}

// Convenience for callers that hold an h2h market array [{name,price}...] where the
// draw is named "Draw". Extracts fair probs and derives. homeTeam/awayTeam name the
// non-draw outcomes. Returns the same shape as deriveFromFair.
function deriveFromH2H(h2h, homeTeam, awayTeam, opts = {}) {
  if (!Array.isArray(h2h) || h2h.length < 3) return { markets: {}, lH: null, lA: null }
  const isDraw = (n) => /^(draw|tie|x)$/i.test(String(n || '').trim())
  const home = h2h.find(o => o.name === homeTeam)
  const away = h2h.find(o => o.name === awayTeam)
  const draw = h2h.find(o => isDraw(o.name))
  if (!home || !away || !draw) return { markets: {}, lH: null, lA: null }
  const fp = fairProbs(home.price, draw.price, away.price)
  return deriveFromFair(fp, { home: homeTeam, away: awayTeam }, opts)
}

module.exports = { fairProbs, deriveFromFair, deriveFromH2H }
