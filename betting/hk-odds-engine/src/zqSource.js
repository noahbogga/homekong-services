// zqSource.js — pulls Chinese football data from the ZQ API (relay VPS) and
// reduces each match to the evidence shape the AI odds enricher needs:
//   { cnHome, cnAway, league, kickoff, form:{home,away}, injuries:{home,away},
//     h2h, strength:{home,away}, spf:{w,d,l} }
// All ZQ match fields are JSON-encoded STRINGS — every nested field is parsed.
// Team names are Chinese; nameMap.js resolves them to English downstream.
//
// Fetches via the engine's normal egress. Base URL + key from env / data files.
const fs = require('fs')
const path = require('path')

const ZQ_URL = (process.env.ZQ_API_URL || 'https://zx.wxyz.stream').replace(/\/+$/, '')
const KEY_FILE = path.join(__dirname, '../data/zq-token.txt')
// Optional pinned-IP override for testing before DNS propagates:
//   ZQ_RESOLVE="zx.wxyz.stream:155.103.157.108"  (host maps to IP via fetch dispatcher)
const MODULES = ['jczq', 'bjdc', 'zq14', 'sfgg']
const REQ_TIMEOUT_MS = 20000

function getKey() {
  if (process.env.ZQ_API_KEY) return process.env.ZQ_API_KEY.trim()
  try { return fs.readFileSync(KEY_FILE, 'utf-8').trim() } catch { return null }
}

// ── safe JSON.parse for ZQ's stringified fields ──────────────
function pj(v, fallback) {
  if (v == null || v === '') return fallback
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return fallback }
}

// ── form string from a recent-match list, from OUR team's perspective ──
// Each entry: {homeTeamName,awayTeamName,homeTeamScore,awayTeamScore,futureDay}.
// futureDay < 0 = already played. Newest first in ZQ; we output oldest→newest.
function formFromRecent(recentList, teamName, lastN = 5) {
  if (!Array.isArray(recentList) || !teamName) return ''
  const played = recentList
    .filter(m => (m.futureDay == null || m.futureDay < 0) &&
                 m.homeTeamScore != null && m.awayTeamScore != null)
    .sort((a, b) => String(a.matchDate).localeCompare(String(b.matchDate))) // oldest→newest
  const out = []
  for (const m of played) {
    const isHome = m.homeTeamName === teamName
    const isAway = m.awayTeamName === teamName
    if (!isHome && !isAway) continue
    const gf = isHome ? +m.homeTeamScore : +m.awayTeamScore
    const ga = isHome ? +m.awayTeamScore : +m.homeTeamScore
    out.push(gf > ga ? 'W' : gf < ga ? 'L' : 'D')
  }
  return out.slice(-lastN).join('')
}

// ── injuries: field is [teamName,"球员","状态","影响", ...playerNames] ──
// First 4 entries are the team label + column headers; rest are injured players.
// "暂无数据" = no data.
function injuriesFrom(arr) {
  if (!Array.isArray(arr) || arr.length <= 4) return []
  const players = arr.slice(4).filter(x => x && x !== '暂无数据' && String(x).trim())
  return players
}

// ── attack/defense: pull shots-for / shots-against per game from the flat CN array ──
// Shape: ["攻防特征","12.3 次","场均射门","8.3 次", ...,"10.3 次","场均被射门","10.7 次", ...]
// where a label ("场均射门"=shots/game, "场均被射门"=shots conceded/game) is FLANKED by the
// home value (before) and away value (after). Returns {shotsFor:{h,a}, shotsAgainst:{h,a}}.
function attackDefenseFrom(arr) {
  if (!Array.isArray(arr)) return null
  const num = (s) => { const m = String(s).match(/([\d.]+)/); return m ? parseFloat(m[1]) : null }
  const out = {}
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i] === '场均射门') out.shotsFor = { h: num(arr[i - 1]), a: num(arr[i + 1]) }
    else if (arr[i] === '场均被射门') out.shotsAgainst = { h: num(arr[i - 1]), a: num(arr[i + 1]) }
  }
  return (out.shotsFor || out.shotsAgainst) ? out : null
}

// ── h2h goal record from the head-to-head list (last N meetings) ──
// Returns { games, avgGoals, homeWins, awayWins, draws } from the CURRENT home team's view.
function h2hStatsFrom(list, curHomeCN, lastN = 6) {
  if (!Array.isArray(list) || !curHomeCN) return null
  const games = list
    .filter(x => x.homeTeamScore != null && x.awayTeamScore != null)
    .slice(0, lastN)
  if (!games.length) return null
  let goals = 0, hw = 0, aw = 0, d = 0
  for (const g of games) {
    const hs = +g.homeTeamScore, as = +g.awayTeamScore
    goals += hs + as
    // normalize to the current home team's perspective
    const curIsHome = g.homeTeamName === curHomeCN
    const cur = curIsHome ? hs : as, opp = curIsHome ? as : hs
    if (cur > opp) hw++; else if (cur < opp) aw++; else d++
  }
  return { games: games.length, avgGoals: +(goals / games.length).toFixed(2), homeWins: hw, awayWins: aw, draws: d }
}

// ── reduce one raw ZQ match into the evidence shape ──────────
function reduceMatch(m, moduleCode) {
  const home = m.home_team, away = m.away_team
  if (!home || !away) return null

  const recentHome = pj(m.history_home_recent_list, [])
  const recentAway = pj(m.history_away_recent_list, [])
  const h2h = pj(m.history_h2h_list, [])

  const injHome = injuriesFrom(pj(m.lineup_injury_home, []))
  const injAway = injuriesFrom(pj(m.lineup_injury_away, []))

  const form = {
    home: formFromRecent(recentHome, home),
    away: formFromRecent(recentAway, away),
  }

  // kickoff: normalize the feed's two time shapes into ONE Beijing-local string
  // "YYYY-MM-DD HH:MM:SS" (the feed clock is UTC+8 — converted to UTC downstream
  // in zqBettable). Shapes seen live:
  //   jczq: match_time = "2026-08-19 18:30:00" (full datetime)
  //   bjdc: match_time = "02:55" (HH:MM only) + match_date = "2026-08-18"
  // Combining the HH:MM form with match_date is what stops those matches from
  // collapsing to a date-only string (which never ages out of "upcoming").
  let kickoff = ''
  const mt = (m.match_time || '').trim()
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(mt)) {
    // Full datetime already — keep date + HH:MM(:SS), space-separated.
    const mm = mt.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/)
    kickoff = `${mm[1]} ${mm[2]}${mm[3] || ':00'}`
  } else if (/^\d{1,2}:\d{2}/.test(mt) && /^\d{4}-\d{2}-\d{2}$/.test(m.match_date || '')) {
    // HH:MM only (bjdc). match_date is the lottery LISTING day; per the feed's own
    // convention (visible in jczq's full datetimes) early-morning kickoffs belong to
    // the NEXT calendar day — e.g. jczq lists a 03:00/06:00 Beijing match under the
    // prior date. Replicate that: AM hours (< 12) roll match_date +1, PM stays.
    const hm = mt.match(/^(\d{1,2}):(\d{2})/)
    const hh = parseInt(hm[1], 10)
    let dayStr = m.match_date
    if (hh < 12) {
      // Add one day using UTC math (date-only, no tz drift), reformat YYYY-MM-DD.
      const nd = new Date(m.match_date + 'T00:00:00Z')
      nd.setUTCDate(nd.getUTCDate() + 1)
      dayStr = nd.toISOString().slice(0, 10)
    }
    kickoff = `${dayStr} ${String(hh).padStart(2, '0')}:${hm[2]}:00`
  } else {
    // No usable time — keep the date alone (rare; downstream treats as day-level).
    kickoff = m.match_date || ''
  }

  const sh = parseFloat(m.overall_strength_home_score)
  const sa = parseFloat(m.overall_strength_away_score)

  // richer evidence (all optional — null if the feed field is absent/unparseable)
  const attackDefense = attackDefenseFrom(pj(m.strength_compare_attack_defense, null))
  const h2hStats = h2hStatsFrom(h2h, home)

  return {
    module: moduleCode,
    cnHome: home,
    cnAway: away,
    league: m.league_name || '',
    kickoff,
    matchId: m.match_id2 || m.match_id || '',
    form,
    injuries: { home: injHome, away: injAway },
    h2hCount: Array.isArray(h2h) ? h2h.length : 0,
    strength: { home: isNaN(sh) ? null : sh, away: isNaN(sa) ? null : sa },
    attackDefense,   // {shotsFor:{h,a}, shotsAgainst:{h,a}} — drives totals/BTTS signal
    h2hStats,        // {games, avgGoals, homeWins, awayWins, draws} from home POV
    spf: {
      handicap: (m.spf_handicap != null && m.spf_handicap !== '') ? parseFloat(m.spf_handicap) : 0,
      w: parseFloat(m.spf_win_odds) || null,
      d: parseFloat(m.spf_draw_odds) || null,
      l: parseFloat(m.spf_lose_odds) || null,
    },
    // Handicap 1X2 (让球胜平负): win/draw/lose priced AFTER applying rqspf.handicap
    // goals to the home side. This is the extra bettable market ZQ adds.
    rqspf: {
      handicap: (m.rqspf_handicap != null && m.rqspf_handicap !== '') ? parseFloat(m.rqspf_handicap) : null,
      w: parseFloat(m.rqspf_win_odds) || null,
      d: parseFloat(m.rqspf_draw_odds) || null,
      l: parseFloat(m.rqspf_lose_odds) || null,
    },
    homeSummary: m.history_home_summary || '',
    awaySummary: m.history_away_summary || '',
  }
}

// ── HTTP GET one module's matches (debug=false keeps payload lean) ──
async function fetchModule(moduleCode, { pageSize = 100 } = {}) {
  const key = getKey()
  if (!key) throw new Error('no ZQ API key (data/zq-token.txt or ZQ_API_KEY)')
  const url = `${ZQ_URL}/api/v1/modules/${moduleCode}/matches?page_size=${pageSize}&debug=false`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  let resp
  try {
    resp = await fetch(url, {
      headers: { 'X-API-Key': key },
      signal: ctrl.signal,
    })
  } finally { clearTimeout(timer) }
  if (!resp.ok) throw new Error(`ZQ ${moduleCode} HTTP ${resp.status}`)
  const data = await resp.json()
  const matches = (data && data.data && data.data.matches) || []
  return matches
}

// ── pull all modules, reduce, dedupe by (cnHome,cnAway) ──────
// Returns an array of evidence objects. Never throws for a single bad module.
async function fetchAll({ pageSize = 100 } = {}) {
  const seen = new Set()
  const out = []
  for (const mod of MODULES) {
    let matches
    try { matches = await fetchModule(mod, { pageSize }) }
    catch (e) { console.error(`[zq] ${mod}: ${e.message}`); continue }
    for (const raw of matches) {
      const ev = reduceMatch(raw, mod)
      if (!ev) continue
      const dedup = `${ev.cnHome}|${ev.cnAway}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      out.push(ev)
    }
  }
  return out
}

// ── health probe (authenticated: /health is not exposed publicly) ──
async function health() {
  const key = getKey()
  if (!key) return false
  try {
    const r = await fetch(`${ZQ_URL}/api/v1/meta`, {
      headers: { 'X-API-Key': key },
      signal: AbortSignal.timeout(8000),
    })
    return r.ok
  } catch { return false }
}

module.exports = {
  fetchAll, fetchModule, reduceMatch, formFromRecent, injuriesFrom, health,
  ZQ_URL, MODULES,
}
