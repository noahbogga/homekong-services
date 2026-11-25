// ahModel.js — derive a TRUE Asian Handicap (2-way, no draw, quarter lines) from the
// fair 1X2 probabilities we already have. No new feed data: fit an independent-Poisson
// goals model to the 1X2 probs, then integrate the scoreline grid to price any handicap
// line — including the split (quarter) lines that make an AH an AH. ZQ's own rqspf 3-way
// handicap is used only as a calibration sanity check, not as the price source.
//
// Method:
//   1. caller strips vig from 1X2 -> fair (pH, pD, pA).
//   2. fit Poisson means (lambdaH, lambdaA) so implied win/draw/lose match, via nested
//      bisection on total goals T=lH+lA (controls draw rate) and supremacy S=lH-lA
//      (controls the home/away tilt) — both monotonic, so the solve is stable.
//   3. main line = supremacy rounded to nearest 0.25 (the balanced line), as a HOME hcp.
//   4. price home/away cover at that line, push-aware, then apply the house overround.

const MAX_GOALS = 12

// Poisson pmf: e^-λ · λ^k / k!  (iterative, no factorial overflow)
function poisson(k, lambda) {
  let p = Math.exp(-lambda)
  for (let i = 1; i <= k; i++) p *= lambda / i
  return p
}

// win/draw/lose probs implied by two Poisson means (home goals vs away goals)
function outcomeProbs(lH, lA) {
  const ph = [], pa = []
  for (let k = 0; k <= MAX_GOALS; k++) { ph[k] = poisson(k, lH); pa[k] = poisson(k, lA) }
  let win = 0, draw = 0, lose = 0
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = ph[h] * pa[a]
      if (h > a) win += p
      else if (h === a) draw += p
      else lose += p
    }
  }
  return { win, draw, lose }
}

// Fit Poisson means to target fair (pH, pD, pA). Two nested monotonic bisections:
//   outer: total goals T (higher T -> lower draw rate) matched to pD
//   inner: supremacy S=lH-lA (higher S -> higher win rate) matched to pH within its share
// Returns { lH, lA, fit:{win,draw,lose} }.
function fitPoisson(pH, pD, pA) {
  const targetDraw = pD
  // home share of the decisive mass -> where supremacy should land
  const decisive = pH + pA
  const targetHomeOfDecisive = decisive > 0 ? pH / decisive : 0.5

  // inner: given T, find S so win/(win+lose) matches targetHomeOfDecisive
  function solveSupremacy(T) {
    let lo = -T + 0.001, hi = T - 0.001   // |S| < T so both means stay positive
    for (let it = 0; it < 40; it++) {
      const S = (lo + hi) / 2
      const lH = (T + S) / 2, lA = (T - S) / 2
      const { win, lose } = outcomeProbs(lH, lA)
      const share = (win + lose) > 0 ? win / (win + lose) : 0.5
      if (share < targetHomeOfDecisive) lo = S; else hi = S
    }
    const S = (lo + hi) / 2
    return { lH: (T + S) / 2, lA: (T - S) / 2 }
  }

  // outer: find T so the model draw rate matches targetDraw (draw falls as T rises)
  let lo = 0.4, hi = 8.0
  for (let it = 0; it < 40; it++) {
    const T = (lo + hi) / 2
    const { lH, lA } = solveSupremacy(T)
    const { draw } = outcomeProbs(lH, lA)
    if (draw > targetDraw) lo = T; else hi = T   // more total goals -> fewer draws
  }
  const T = (lo + hi) / 2
  const { lH, lA } = solveSupremacy(T)
  return { lH, lA, fit: outcomeProbs(lH, lA) }
}

// Price a 2-way AH at a single WHOLE-or-HALF line (home handicap `line`, applied to home
// goals) from fitted Poisson means. Returns { pHome, pAway, pPush } as fair probabilities
// of the HOME-cover / AWAY-cover / push (stake-refund) outcomes.
//   margin = (homeGoals + line) - awayGoals ; >0 home covers, <0 away covers, =0 push.
function priceSimpleLine(lH, lA, line) {
  const ph = [], pa = []
  for (let k = 0; k <= MAX_GOALS; k++) { ph[k] = poisson(k, lH); pa[k] = poisson(k, lA) }
  let pHome = 0, pAway = 0, pPush = 0
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = ph[h] * pa[a]
      const margin = (h + line) - a
      if (margin > 1e-9) pHome += p
      else if (margin < -1e-9) pAway += p
      else pPush += p            // only possible on whole/half-integer lines
    }
  }
  return { pHome, pAway, pPush }
}

// Price ANY line, including quarter (split) lines like -0.25 / -0.75. A quarter line is
// the average of the two adjacent half/whole lines (stake split in two). Push mass is
// folded back proportionally (a push refunds that half), giving the effective fair win
// probability for each side on a "to win the whole stake" basis.
function priceLine(lH, lA, line) {
  const q = Math.round(line * 4) / 4
  const isQuarter = Math.abs((q * 2) - Math.round(q * 2)) > 1e-9  // .25 / .75 part
  const legs = isQuarter ? [q - 0.25, q + 0.25] : [q]
  let home = 0, away = 0
  for (const L of legs) {
    const { pHome, pAway, pPush } = priceSimpleLine(lH, lA, L)
    // push refunds that leg's half-stake: treat as neutral, renormalize onto win/loss
    const live = pHome + pAway
    const hWin = live > 0 ? pHome / live : 0.5
    home += hWin / legs.length
    away += (1 - hWin) / legs.length
  }
  return { pHome: home, pAway: away }
}

// ── MAIN: build a 2-way Asian Handicap market from fair 1X2 probs ──
// fairH/fairD/fairA: vig-stripped 1X2 probabilities (must sum ~1).
// overround: house target (e.g. 1.07). names: {home, away} English team names.
// Returns [{name, price, point}, {name, price, point}] (home line, away = -line), or null.
// step: line granularity. 0.5 = half-ball lines only (whole/half — all-or-nothing +
// push settlement, no partial payouts). 0.25 = split-ball quarter lines (needs
// partial-payout settlement). Default 0.5 to match current settlement semantics.
function buildAsianHandicap(fairH, fairD, fairA, overround, names, step = 0.5) {
  const s = fairH + fairD + fairA
  if (!(s > 0)) return null
  const pH = fairH / s, pD = fairD / s, pA = fairA / s
  if (pD <= 0 || pD >= 1) return null

  const { lH, lA } = fitPoisson(pH, pD, pA)
  if (!(lH > 0) || !(lA > 0)) return null

  // balanced main line = supremacy snapped to the line granularity, as a HOME handicap
  const supremacy = lH - lA
  const snap = 1 / step
  const homeLine = -(Math.round(supremacy * snap) / snap)   // favourite gets a negative line
  const { pHome, pAway } = priceLine(lH, lA, homeLine)
  if (!(pHome > 0) || !(pAway > 0)) return null

  // apply house overround, convert to decimal odds. pHome+pAway==1 here (2-way, push
  // folded out), so each implied prob = fair * overround and the book sums to overround.
  const priceHome = Math.max(1.01, +(1 / (pHome * overround)).toFixed(3))
  const priceAway = Math.max(1.01, +(1 / (pAway * overround)).toFixed(3))

  return [
    { name: names.home, price: priceHome, point: homeLine },
    { name: names.away, price: priceAway, point: -homeLine },
  ]
}

// ── shared scoreline grid: p[h][a] = P(home=h, away=a) under independent Poisson ──
function scoreGrid(lH, lA) {
  const ph = [], pa = []
  for (let k = 0; k <= MAX_GOALS; k++) { ph[k] = poisson(k, lH); pa[k] = poisson(k, lA) }
  const g = []
  for (let h = 0; h <= MAX_GOALS; h++) { g[h] = []; for (let a = 0; a <= MAX_GOALS; a++) g[h][a] = ph[h] * pa[a] }
  return g
}

// odds from a fair prob + house overround (each side carries the full overround so the
// 2-way book sums to `overround`). Floor at 1.01.
function toPrice(fairP, overround) {
  if (!(fairP > 0)) return null
  return Math.max(1.01, +(1 / (fairP * overround)).toFixed(3))
}

// ── Over/Under total goals. Returns [{name:'Over',price,point},{name:'Under',price,point}]
// totalsShift (optional, from the AI engine) nudges the fair Over prob by ±shift before
// margin, same clamp convention as h2h shifts. Push on whole-number lines -> handled at
// settlement (over==line is a push); we snap to half lines by default so no push.
function buildOverUnder(lH, lA, overround, line, totalsShift = 0) {
  const g = scoreGrid(lH, lA)
  let over = 0, under = 0, push = 0
  for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) {
    const t = h + a
    if (t > line + 1e-9) over += g[h][a]
    else if (t < line - 1e-9) under += g[h][a]
    else push += g[h][a]
  }
  // fold push out proportionally (half-line has none), then apply AI totals shift
  const live = over + under
  if (!(live > 0)) return null
  let pOver = over / live
  pOver = Math.max(0.02, Math.min(0.98, pOver + (Number(totalsShift) || 0)))
  const pUnder = 1 - pOver
  const po = toPrice(pOver, overround), pu = toPrice(pUnder, overround)
  if (!po || !pu) return null
  return [{ name: 'Over', price: po, point: line }, { name: 'Under', price: pu, point: line }]
}

// pick the O/U line closest to expected total goals, snapped to .5 (no push)
function mainTotalLine(lH, lA) {
  const exp = lH + lA
  return Math.max(0.5, Math.round(exp - 0.5) + 0.5)   // nearest x.5
}

// ── Both Teams To Score: P(home>=1 AND away>=1). 2-way Yes/No. ──
function buildBTTS(lH, lA, overround) {
  const g = scoreGrid(lH, lA)
  let yes = 0
  for (let h = 1; h <= MAX_GOALS; h++) for (let a = 1; a <= MAX_GOALS; a++) yes += g[h][a]
  const no = 1 - yes
  const py = toPrice(yes, overround), pn = toPrice(no, overround)
  if (!py || !pn) return null
  return [{ name: 'Yes', price: py }, { name: 'No', price: pn }]
}

// ── Double Chance (1X, 12, X2) from fair 1X2 probs. 3 combined-cover outcomes. ──
// names: {home, away}. Each outcome covers two of the three 1X2 results.
function buildDoubleChance(pH, pD, pA, overround, names) {
  const s = pH + pD + pA; if (!(s > 0)) return null
  const h = pH / s, d = pD / s, a = pA / s
  const p1x = toPrice(h + d, overround)   // home or draw
  const p12 = toPrice(h + a, overround)   // home or away
  const px2 = toPrice(d + a, overround)   // draw or away
  if (!p1x || !p12 || !px2) return null
  return [
    { name: `${names.home} or Draw`, price: p1x, code: '1X' },
    { name: `${names.home} or ${names.away}`, price: p12, code: '12' },
    { name: `Draw or ${names.away}`, price: px2, code: 'X2' },
  ]
}

// ── Draw No Bet: 2-way, draw refunds stake. Fair = win/(win+lose) split of decisive mass. ──
function buildDrawNoBet(pH, pD, pA, overround, names) {
  const dec = pH + pA; if (!(dec > 0)) return null
  const ph = toPrice(pH / dec, overround), pa = toPrice(pA / dec, overround)
  if (!ph || !pa) return null
  return [{ name: names.home, price: ph }, { name: names.away, price: pa }]
}

// ── AH ladder: price several half-ball lines around the balanced line. ──
// Returns [{ line, home:{name,price,point}, away:{name,price,point} }, ...].
function buildAhLadder(lH, lA, overround, names, spread = 1, step = 0.5) {
  const supremacy = lH - lA
  const center = -(Math.round(supremacy / step) * step)   // home handicap
  const out = []
  for (let d = -spread; d <= spread; d += step) {
    const homeLine = +(center + d).toFixed(2)
    const { pHome, pAway } = priceLine(lH, lA, homeLine)
    const ph = toPrice(pHome, overround), pa = toPrice(pAway, overround)
    if (!ph || !pa) continue
    out.push({
      line: homeLine,
      home: { name: names.home, price: ph, point: homeLine },
      away: { name: names.away, price: pa, point: -homeLine },
    })
  }
  return out
}

// ── Correct Score ─────────────────────────────────────────────────────────────
// Price each explicit scoreline from scoreGrid. Included probs are normalised to
// sum=1 so the book margin is exactly `overround` for the listed outcomes; any
// result outside the grid simply loses. Outcomes below CS_MIN_P are dropped.
const CS_MIN_P = 0.003
function buildCorrectScore(lH, lA, overround, maxGoals = 4) {
  const g = scoreGrid(lH, lA)
  const raw = []
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = g[h][a]
      if (p >= CS_MIN_P) raw.push({ name: `${h}-${a}`, p, point: `${h}-${a}` })
    }
  }
  const sum = raw.reduce((s, o) => s + o.p, 0)
  if (!(sum > 0)) return []
  return raw
    .map(o => ({ name: o.name, price: toPrice(o.p / sum, overround), point: o.point }))
    .filter(o => o.price)
    .sort((a, b) => a.price - b.price)   // cheapest (most likely) first
}

// ── Goals Ladder ──────────────────────────────────────────────────────────────
// Over/Under at every half-ball line 0.5 → 4.5 — a wider market than the 3-line
// `totals`. Each pair shares the same `point` so the NUI can group into a ladder.
// Only lines where a side is floored to ~1.01 (dead cert) are dropped; the
// "banker" lines (Over 0.5 / Under 4.5) survive so players can pick them.
function buildGoalsLadder(lH, lA, overround) {
  const flat = []
  for (let line = 0.5; line <= 4.5; line += 1.0) {
    const pair = buildOverUnder(lH, lA, overround, line, 0)
    if (!pair) continue
    if (pair.some(o => o.price < 1.02)) continue   // only drop truly dead lines
    flat.push(...pair)
  }
  return flat
}

// ── Half-Time Lines ───────────────────────────────────────────────────────────
// Model first-half scoring as independent Poisson with HT_FRACTION of full means.
// Returns { htAh: AH ladder, htTotals: O/U ladder } using the same builders.
// Callers store these as markets 'ht_ah' and 'ht_totals'.
// Settlement requires a half-time score source (void until implemented).
const HT_FRACTION = 0.45
function buildHalfLines(lH, lA, overround, names) {
  const lHht = lH * HT_FRACTION, lAht = lA * HT_FRACTION
  const htAh = buildAhLadder(lHht, lAht, overround, names, 1, 0.5)
  const htTotals = []
  for (const line of [0.5, 1.5, 2.5]) {
    const pair = buildOverUnder(lHht, lAht, overround, line, 0)
    if (pair && !pair.some(o => o.price < 1.05)) htTotals.push(...pair)
  }
  return { htAh, htTotals }
}

// ── HT/FT Combined ────────────────────────────────────────────────────────────
// 9-way market: result at half-time × result at full-time (e.g. "Home/Draw").
// First and second halves modelled as independent Poisson processes that share
// the full-match lambdas: lH_ht = lH×0.45, lH_2h = lH×0.55.
// Settlement requires a half-time score source (void until implemented).
function buildHTFT(lH, lA, overround, names) {
  const lHht = lH * HT_FRACTION,  lAht = lA * HT_FRACTION
  const lH2h = lH * (1 - HT_FRACTION), lA2h = lA * (1 - HT_FRACTION)
  const g_ht = scoreGrid(lHht, lAht)
  const g_2h = scoreGrid(lH2h, lA2h)

  const p = { HH: 0, HD: 0, HA: 0, DH: 0, DD: 0, DA: 0, AH: 0, AD: 0, AA: 0 }
  for (let hht = 0; hht <= MAX_GOALS; hht++) {
    for (let aht = 0; aht <= MAX_GOALS; aht++) {
      const pht = g_ht[hht][aht]
      if (!(pht > 1e-12)) continue
      const htR = hht > aht ? 'H' : hht < aht ? 'A' : 'D'
      for (let h2h = 0; h2h <= MAX_GOALS; h2h++) {
        for (let a2h = 0; a2h <= MAX_GOALS; a2h++) {
          const p2h = g_2h[h2h][a2h]
          if (!(p2h > 1e-12)) continue
          const ftH = hht + h2h, ftA = aht + a2h
          const ftR = ftH > ftA ? 'H' : ftH < ftA ? 'A' : 'D'
          p[htR + ftR] += pht * p2h
        }
      }
    }
  }

  const LABELS = {
    HH: `${names.home}/${names.home}`,
    HD: `${names.home}/Draw`,
    HA: `${names.home}/${names.away}`,
    DH: `Draw/${names.home}`,
    DD: 'Draw/Draw',
    DA: `Draw/${names.away}`,
    AH: `${names.away}/${names.home}`,
    AD: `${names.away}/Draw`,
    AA: `${names.away}/${names.away}`,
  }
  const outcomes = []
  for (const [code, label] of Object.entries(LABELS)) {
    if (!(p[code] >= CS_MIN_P)) continue
    const price = toPrice(p[code], overround)
    if (price) outcomes.push({ name: label, price, code })
  }
  return outcomes.sort((a, b) => a.price - b.price)
}

module.exports = {
  buildAsianHandicap, buildOverUnder, mainTotalLine, buildBTTS,
  buildDoubleChance, buildDrawNoBet, buildAhLadder,
  buildCorrectScore, buildGoalsLadder, buildHalfLines, buildHTFT,
  fitPoisson, priceLine, outcomeProbs, poisson, scoreGrid,
}

