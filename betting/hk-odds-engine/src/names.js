// names.js — team-name normalization + fuzzy matching.
// Shared by the SharpAPI outcome-dedup (collapsing per-sportsbook name variants
// like "Bayern Munich" vs "Bayern Munchen") and the soccer form enricher
// (matching odds-cache names like "Atletico Paranaense" to the football data API's
// "CA Paranaense"). No deps.

// Club-type tokens that carry no identifying signal — dropped before matching.
const NOISE = new Set([
  'fc', 'cf', 'sc', 'ca', 'ec', 'se', 'rb', 'ac', 'as', 'cd', 'afc', 'sv',
  'club', 'clube', 'de', 'do', 'da', 'dos', 'das', 'the', 'futebol',
  'city', 'united', 'utd', // kept out of NOISE below — see note
])
// NOTE: "city"/"united" ARE identifying in England (Man City vs Man United),
// so we do NOT strip them. Remove from the noise set.
NOISE.delete('city'); NOISE.delete('united'); NOISE.delete('utd')

const DRAW_WORDS = new Set(['draw', 'tie', 'x', 'empate', 'nul', 'unentschieden'])

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// Normalize to a set of meaningful lowercase tokens.
function tokens(name) {
  if (!name) return []
  const clean = stripAccents(String(name).toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const toks = clean.split(' ').filter(t => t && !NOISE.has(t))
  return toks.length ? toks : clean.split(' ').filter(Boolean) // fallback: don't nuke to empty
}

function isDraw(selection) {
  const t = stripAccents(String(selection || '').toLowerCase()).replace(/[^a-z]/g, '')
  return DRAW_WORDS.has(t)
}

// Overlap score between two names: size of shared meaningful-token set.
function overlap(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b))
  let n = 0
  for (const t of A) if (B.has(t)) n++
  return n
}

// Jaccard similarity on meaningful tokens (0..1).
function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const union = A.size + B.size - inter
  return union ? inter / union : 0
}

// Given a selection and the two canonical team names, return 'home' | 'away' | null
// by nearest token overlap. Ties / zero overlap => null (caller can drop it).
function nearestSide(selection, homeTeam, awayTeam) {
  const h = overlap(selection, homeTeam)
  const a = overlap(selection, awayTeam)
  if (h === 0 && a === 0) return null
  if (h > a) return 'home'
  if (a > h) return 'away'
  return null // ambiguous
}

// Best match of `target` among `candidates` (array of strings). Returns
// { value, score } or null if nothing clears the threshold.
function bestMatch(target, candidates, minSim = 0.5) {
  let best = null
  for (const c of candidates) {
    const s = similarity(target, c)
    const ov = overlap(target, c)
    // Accept on decent jaccard OR a clear subset (all tokens of the shorter
    // name present in the longer), which covers "CA Paranaense" ⊆ "Atletico Paranaense".
    const shorter = tokens(target).length <= tokens(c).length ? target : c
    const subset = ov > 0 && ov === new Set(tokens(shorter)).size
    if ((s >= minSim || subset) && (!best || s > best.score)) best = { value: c, score: s }
  }
  return best
}

module.exports = { tokens, isDraw, overlap, similarity, nearestSide, bestMatch, stripAccents }
