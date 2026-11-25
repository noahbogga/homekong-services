// aiAdjust.js — calls the local AI odds model (.209:8091) and applies its
// probability-shift judgments to cached match odds.
//
// The model returns DIRECTION + MAGNITUDE shifts, not prices. This module does
// the exact price math: strip vig -> apply shift -> renormalize -> restore the
// market's ORIGINAL overround (NOT a fixed margin), so a zero-shift match is
// mathematically unchanged and only real shifts move prices.
//
// Requires Node 18+ (uses global fetch). Runs INSIDE the hk-odds-engine container.
const fs = require('fs')
const path = require('path')

const AI_URL = process.env.AI_ODDS_URL || 'http://192.168.50.209:8091/v1/chat/completions'
const TOKEN_FILE = path.join(__dirname, '../data/ai-token.txt')

function getToken() {
  if (process.env.AI_ODDS_TOKEN) return process.env.AI_ODDS_TOKEN.trim()
  try { return fs.readFileSync(TOKEN_FILE, 'utf-8').trim() } catch { return null }
}

// Gates
const MIN_CONFIDENCE = 0.4
const MIN_H2H_SHIFT = 0.015
const MIN_TOTALS_SHIFT = 0.015
const MIN_PROB = 0.02           // clamp floor so a single shift can't drive an outcome
                                // to insane odds; the drift-cycle sanity clamp
                                // (oddsSanity.js) is the real backstop against compounding.
const REQ_TIMEOUT_MS = 20000

// ── Evidence gate ─────────────────────────────────────────────
// Events currently hold ONLY odds. The model needs form/injury signal to say
// anything but ~0. So we skip the GPU call entirely unless an event carries
// evidence. A future form/injury source should populate event.form /
// event.injuries / event.notes (see handoff). No evidence => no call => no-op.
function hasEvidence(ev) {
  if (!ev) return false
  const f = ev.form
  const formOk = f && ((f.home && f.home.length) || (f.away && f.away.length))
  const inj = ev.injuries
  const injOk = inj && (Array.isArray(inj) ? inj.length
                        : ((inj.home && inj.home.length) || (inj.away && inj.away.length)))
  const notesOk = ev.notes && String(ev.notes).trim().length > 0
  return Boolean(formOk || injOk || notesOk)
}

// ── Format one event into the text the model expects ──────────
function formatMatchText(ev) {
  const league = (ev.sportKey || '').replace(/^soccer_|^basketball_|^icehockey_|^mma_|^boxing_/, '')
  const h2h = ev.markets && ev.markets.h2h
  let odds = ''
  if (h2h && h2h.length) {
    const home = h2h.find(o => o.name === ev.homeTeam)
    const away = h2h.find(o => o.name === ev.awayTeam)
    const draw = h2h.find(o => o.name === 'Draw')
    const parts = [home && home.price, draw && draw.price, away && away.price].filter(v => v != null)
    if (parts.length) odds = ' h2h ' + parts.map(p => (+p).toFixed(2)).join('/')
  }
  const tot = ev.markets && ev.markets.totals
  let ou = ''
  if (tot && tot.length) {
    const over = tot.find(o => /over/i.test(o.name))
    const under = tot.find(o => /under/i.test(o.name))
    if (over && under) ou = ` OU${over.point != null ? over.point : ''} ${(+over.price).toFixed(2)}/${(+under.price).toFixed(2)}`
  }
  let ev_txt = `${ev.homeTeam}(home) v ${ev.awayTeam} ${league}.${odds}${ou}.`
  const f = ev.form
  if (f && (f.home || f.away)) ev_txt += ` Form ${ev.homeTeam} ${f.home || '?'}, ${ev.awayTeam} ${f.away || '?'}.`
  if (ev.injuries) {
    const inj = ev.injuries
    if (Array.isArray(inj) && inj.length) ev_txt += ' Injuries: ' + inj.join('; ') + '.'
    else {
      if (inj.home && inj.home.length) ev_txt += ` ${ev.homeTeam} injuries: ${inj.home.join('; ')}.`
      if (inj.away && inj.away.length) ev_txt += ` ${ev.awayTeam} injuries: ${inj.away.join('; ')}.`
    }
  }
  // overall strength (ZQ composite 0-100) — quality gap signal
  if (ev.strength && (ev.strength.home != null || ev.strength.away != null)) {
    ev_txt += ` Strength ${ev.homeTeam} ${ev.strength.home ?? '?'} vs ${ev.awayTeam} ${ev.strength.away ?? '?'}.`
  }
  // attack/defense: shots for/against per game — the main totals & BTTS driver
  const ad = ev.attackDefense
  if (ad) {
    if (ad.shotsFor && (ad.shotsFor.h != null || ad.shotsFor.a != null))
      ev_txt += ` Shots/game ${ev.homeTeam} ${ad.shotsFor.h ?? '?'}, ${ev.awayTeam} ${ad.shotsFor.a ?? '?'}.`
    if (ad.shotsAgainst && (ad.shotsAgainst.h != null || ad.shotsAgainst.a != null))
      ev_txt += ` Shots conceded/game ${ev.homeTeam} ${ad.shotsAgainst.h ?? '?'}, ${ev.awayTeam} ${ad.shotsAgainst.a ?? '?'}.`
  }
  // head-to-head history — recent meetings, avg goals feeds the totals view
  const hh = ev.h2hStats
  if (hh && hh.games) {
    ev_txt += ` H2H last ${hh.games}: ${ev.homeTeam} ${hh.homeWins}W ${hh.draws}D ${hh.awayWins}L, avg ${hh.avgGoals} goals.`
  }
  if (ev.notes) ev_txt += ' ' + String(ev.notes).trim()
  return ev_txt
}

// ── Call the model (one match per request; direct LAN, NOT via proxy) ──
async function fetchJudgment(ev) {
  const token = getToken()
  if (!token) throw new Error('no AI token (data/ai-token.txt or AI_ODDS_TOKEN)')
  const input = formatMatchText(ev)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  let resp
  try {
    resp = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: ctrl.signal,
    })
  } finally { clearTimeout(timer) }
  if (!resp.ok) throw new Error('AI HTTP ' + resp.status)

  const data = await resp.json()
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    && data.choices[0].message.content
  if (!content) throw new Error('AI empty response')
  const parsed = JSON.parse(content)                 // grammar-locked -> always JSON
  const m = parsed.matches && parsed.matches[0]
  if (!m) throw new Error('AI no match in response')
  const clamp = (v) => Math.max(-0.15, Math.min(0.15, +v || 0))
  return {
    home_shift: clamp(m.home_shift),
    draw_shift: clamp(m.draw_shift),
    away_shift: clamp(m.away_shift),
    totals_shift: clamp(m.totals_shift),
    confidence: +m.confidence || 0,
    adjustments: Array.isArray(m.adjustments) ? m.adjustments : [],
  }
}


// ── Reprice one market array, preserving its ORIGINAL overround ──
// shiftFor(outcome) -> probability delta to add to that outcome's FAIR prob.
//
// IDEMPOTENCY: when `baseOutcomes` (the PRISTINE seed prices, never touched by AI or
// drift) is supplied, the shift is computed against the SEED and written onto the live
// `outcomes`. So applying the same judgment twice yields the same price — this is what
// stops the 30-min AI loop from compounding a shift into a runaway (x193/x66). Without a
// base it falls back to repricing the current price (legacy, non-idempotent) — callers
// now avoid that path for h2h.
function repriceMarket(outcomes, shiftFor, baseOutcomes) {
  const base = (baseOutcomes && baseOutcomes.length === outcomes.length) ? baseOutcomes : outcomes
  const inv = base.map(o => 1 / o.price)
  const overround = inv.reduce((a, b) => a + b, 0)     // e.g. 0.987 or 1.06 — keep as-is
  if (!(overround > 0)) return false
  const fair = inv.map(v => v / overround)             // strip vig -> sums to 1

  const idx = {}
  base.forEach((o, i) => { idx[o.name] = i })

  let moved = false
  for (let i = 0; i < base.length; i++) {
    const d = shiftFor(base[i])
    if (d) { fair[i] += d; moved = true }
  }
  if (!moved) return false

  for (let i = 0; i < fair.length; i++) fair[i] = Math.max(MIN_PROB, fair[i])
  const s = fair.reduce((a, b) => a + b, 0)
  const norm = fair.map(v => v / s)                    // renormalize to 1

  // restore the market's original overround, then back to decimal odds. Write onto the
  // live outcomes matched by NAME to the base (order-independent).
  const safeOverround = Math.max(1.01, overround)
  for (const o of outcomes) {
    const i = idx[o.name]
    if (i == null) continue
    const implied = norm[i] * safeOverround
    o.price = Math.max(1.01, +(1 / implied).toFixed(3))
  }
  return true
}

// Normalised last-5 form strength in [0,1] from a "WWDLW" string. null if no data.
function formStrength(seq) {
  const c = String(seq || '').toUpperCase().replace(/[^WDL]/g, '').slice(-5)
  if (!c.length) return null
  let p = 0
  for (const ch of c) p += ch === 'W' ? 3 : ch === 'D' ? 1 : 0
  return p / (c.length * 3)
}

// ── FORM GATE ──────────────────────────────────────────────────
// The .209 model is prone to backwards form reads (e.g. tagging the WEAKER side as
// "home_form_strong") and a home bias. This gate rejects an h2h shift whose NET
// direction contradicts the actual last-5 form differential — UNLESS an injury on the
// side being pushed down justifies it. Returns a (possibly zeroed) copy of the judgment.
function gateOnForm(ev, j) {
  const f = ev.form || {}
  const hs = formStrength(f.home), as = formStrength(f.away)
  if (hs == null || as == null) return j              // no form → can't gate (injury/notes-driven)

  const edge = hs - as                                 // >0 = home in better form
  const netToward = (j.home_shift || 0) - (j.away_shift || 0)  // >0 = pushing toward home
  if (Math.abs(edge) < 0.11 || Math.abs(netToward) < 1e-6) return j   // form inconclusive or no move
  if (Math.sign(edge) === Math.sign(netToward)) return j             // shift agrees with form → ok

  // Contradiction. An injury on the DISFAVOURED side (the one being pushed down) can
  // still justify it (e.g. away keeper out → shift away down despite decent form).
  const inj = ev.injuries || {}
  const side = netToward > 0 ? 'away' : 'home'
  const hasInj = Array.isArray(inj) ? inj.length > 0 : !!(inj[side] && inj[side].length > 0)
  if (hasInj) return j

  // No justification → drop the h2h shift entirely (keep totals_shift; it's gated on O/U).
  return { ...j, home_shift: 0, draw_shift: 0, away_shift: 0, _formGated: true }
}

// ── Apply a judgment to an event's markets in place. Returns true if changed.
// Reprices h2h from the PRISTINE seed (ev._seedH2H) so repeated application is
// idempotent, and only after the form gate clears the shift's direction.
function applyJudgment(ev, j) {
  let changed = false
  j = gateOnForm(ev, j)

  if (j.confidence >= MIN_CONFIDENCE && Math.abs(j.home_shift) >= MIN_H2H_SHIFT) {
    const h2h = ev.markets && ev.markets.h2h
    if (h2h && h2h.length >= 2) {
      // Map model home/draw/away onto the real outcome names. If no Draw exists
      // (2-way), fold draw_shift is irrelevant; home/away already sum-zero.
      const shiftFor = (o) => {
        if (o.name === ev.homeTeam) return j.home_shift
        if (o.name === ev.awayTeam) return j.away_shift
        if (o.name === 'Draw') return j.draw_shift
        return 0
      }
      // Reprice from the pristine seed if we have it (idempotent); else current price.
      if (repriceMarket(h2h, shiftFor, ev._seedH2H)) changed = true
    }
  }

  if (j.confidence >= MIN_CONFIDENCE && Math.abs(j.totals_shift) >= MIN_TOTALS_SHIFT) {
    const tot = ev.markets && ev.markets.totals
    if (tot && tot.length >= 2) {
      const shiftFor = (o) => {
        if (/over/i.test(o.name)) return j.totals_shift
        if (/under/i.test(o.name)) return -j.totals_shift
        return 0
      }
      if (repriceMarket(tot, shiftFor)) changed = true
    }
  }

  if (changed) {
    ev._aiAdjusted = true
    ev._aiConfidence = j.confidence
    ev._aiTags = j.adjustments
    ev._aiAt = new Date().toISOString()
  }
  return changed
}


// ── Adjust a single event: fetch judgment + apply. Returns true if changed.
async function adjustEvent(ev) {
  if (!hasEvidence(ev)) return false          // no form/injury data -> no GPU call
  const j = await fetchJudgment(ev)
  return applyJudgment(ev, j)
}

// ── Orchestrate over all cached sports. Pulls each sport's events via
// getCacheRaw, adjusts evidence-bearing events sequentially (one match/req),
// and writes back via setCache. onAdjusted(sportKey, events) lets the caller
// re-anchor drift so adjustments persist. Returns {adjusted, skipped, errors}.
async function runAiAdjust({ sports, getCacheRaw, setCache, onAdjusted, delayMs = 200 }) {
  let adjusted = 0, skipped = 0, errors = 0
  for (const sportKey of sports) {
    const events = getCacheRaw(sportKey)
    if (!Array.isArray(events) || !events.length) continue
    let sportChanged = false
    for (const ev of events) {
      if (ev._oddsLocked) { skipped++; continue }   // admin-overridden → AI stands down until re-seed
      if (!hasEvidence(ev)) { skipped++; continue }
      try {
        if (await adjustEvent(ev)) { adjusted++; sportChanged = true } else { skipped++ }
      } catch (err) {
        errors++
        console.error(`[ai] ${ev.homeTeam} v ${ev.awayTeam}: ${err.message}`)
      }
      if (delayMs) await new Promise(r => setTimeout(r, delayMs))
    }
    if (sportChanged) {
      setCache(sportKey, events)
      if (onAdjusted) onAdjusted(sportKey, events)   // re-anchor so drift keeps it
    }
  }
  console.log(`[ai] adjusted=${adjusted} skipped=${skipped} errors=${errors}`)
  return { adjusted, skipped, errors }
}

module.exports = {
  runAiAdjust, adjustEvent, applyJudgment, repriceMarket,
  formatMatchText, hasEvidence, fetchJudgment,
  applyFormGate: gateOnForm, formStrength,
}

