// oddsSanity.js — safety clamp for 1X2 (h2h) football markets.
//
// WHY THIS EXISTS: the AI reprice pass (aiAdjust.js) reads the CURRENT h2h price,
// shifts it, then anchors the result so drift won't revert it. The next cycle reads
// its own shifted output and shifts again — a feedback loop that compounds an
// underdog's probability toward zero (we saw Levante hit ~0.5% → x193). This clamp
// runs every drift cycle and:
//   1. bounds each outcome to a sane band around its SEED (raw-feed) probability, so
//      AI/drift can move a line meaningfully but never run away from the market, and
//   2. enforces an absolute implied-probability FLOOR so no outcome — seeded or not,
//      from any feed or a bad model judgment — can ever be served at insane odds.
// It preserves the market's existing overround (house margin) and renormalises, so a
// clamp that touches nothing leaves prices bit-for-bit unchanged.

// Absolute floor on an outcome's implied probability. 0.015 ≈ a longest-shot dog of
// ~x55–65 decimal after overround (admin-chosen cap tightness). Nothing goes beyond.
const MIN_IMPLIED = 0.015

// Seed band: how far AI/drift may pull an outcome from its raw-feed probability before
// we clamp. 0.45×–2.2× lets a genuine form/injury read roughly double or halve a price
// while catching the runaway (which pushes 10×+ away from seed).
const SEED_LOW = 0.45
const SEED_HIGH = 2.2

// Strip a market's overround → fair probs that sum to 1. Returns null if unusable.
function fairOf(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length < 2) return null
  const inv = outcomes.map(o => 1 / o.price)
  if (inv.some(v => !Number.isFinite(v) || v <= 0)) return null
  const over = inv.reduce((a, b) => a + b, 0)
  if (!(over > 0)) return null
  return { fair: inv.map(v => v / over), over }
}

// Clamp an h2h outcome array IN PLACE. `seedOutcomes` (optional, same names) supplies
// the raw-feed anchor for the band; without it only the absolute floor applies.
// Returns true if any price actually changed.
function sanitizeH2H(outcomes, seedOutcomes) {
  const cur = fairOf(outcomes)
  if (!cur) return false
  const safeOver = Math.max(1.01, cur.over)

  // Map seed fair probs by outcome name (order can differ across feeds).
  let seedFair = null
  const s = fairOf(seedOutcomes)
  if (s) {
    seedFair = {}
    seedOutcomes.forEach((o, i) => { seedFair[o.name] = s.fair[i] })
  }

  const clamped = outcomes.map((o, i) => {
    let p = cur.fair[i]
    if (seedFair && seedFair[o.name] != null) {
      const sp = seedFair[o.name]
      p = Math.min(Math.max(p, sp * SEED_LOW), sp * SEED_HIGH)
    }
    return Math.max(p, MIN_IMPLIED)
  })

  const sum = clamped.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return false

  let changed = false
  for (let i = 0; i < outcomes.length; i++) {
    const implied = (clamped[i] / sum) * safeOver
    const price = Math.max(1.01, +(1 / implied).toFixed(3))
    if (price !== outcomes[i].price) changed = true
    outcomes[i].price = price
  }
  return changed
}

// Stamp a PRISTINE copy of the raw-feed h2h onto the event, if not already present.
// This is the baseline AI reprices FROM (idempotent) and the anchor the sanity clamp
// bands against. Set at fetch/seed time, before any AI or drift touches the event.
// `force` overwrites an existing seed (used by a clean re-seed to clear poison).
function stampSeed(ev, force) {
  const h2h = ev && ev.markets && ev.markets.h2h
  if (!Array.isArray(h2h) || h2h.length < 2) return
  if (ev._seedH2H && !force) return
  ev._seedH2H = h2h.map(o => ({ name: o.name, price: o.price }))
}

module.exports = { sanitizeH2H, fairOf, stampSeed, MIN_IMPLIED, SEED_LOW, SEED_HIGH }
