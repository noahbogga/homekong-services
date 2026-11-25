// extractors/detailPage.js — scrape a fixture detail page for extended markets
// Ports the validated Python probe (stake_parse_markets.py) to Node.js Playwright.
// Uses the same TreeWalker DOM-order walk: assign each odds button to its nearest
// preceding market heading.

const { withBrowser } = require('../browser')
const { SPORTS } = require('../sports')

// Validated RAW_JS from stake_parse_markets.py — runs inside the browser.
// Returns { title, headings, sections } where sections[headingText] = [buttonText, ...]
const RAW_JS = `
(headingReStr) => {
  const HEAD = new RegExp(headingReStr, 'i');

  let idx = 0;
  const order = new Map();
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let n = walk.currentNode;
  while (n) { order.set(n, idx++); n = walk.nextNode(); }

  const headings = [...document.querySelectorAll('*')]
    .filter(el => el.childElementCount === 0)
    .map(el => ({ el, text: (el.innerText || '').trim() }))
    .filter(h => HEAD.test(h.text))
    .map(h => ({ text: h.text, idx: order.get(h.el) }))
    .sort((a, b) => a.idx - b.idx);

  const btns = [...document.querySelectorAll('button')]
    .map(b => ({ b, text: (b.innerText || '').replace(/\\s+/g, ' ').trim() }))
    .filter(x => /\\d+\\.\\d{1,3}/.test(x.text))
    .map(x => ({ text: x.text, idx: order.get(x.b) }))
    .sort((a, b) => a.idx - b.idx);

  const sections = {};
  for (const h of headings) sections[h.text] = [];
  for (const bt of btns) {
    let cur = null;
    for (const h of headings) { if (h.idx < bt.idx) cur = h.text; else break; }
    if (cur) sections[cur].push(bt.text);
  }

  return { title: document.title, headings: headings.map(h => h.text), sections };
}
`

// ── parsers (ported from Python) ───────────────────────────────────────────

// "Team A 2.95"  → { name: "Team A", price: 2.95 }
function parseMoneyline(btns) {
  return btns.slice(0, 3).map(t => {
    const parts = t.trim().split(/\s+/)
    const price = parseFloat(parts[parts.length - 1])
    const name = parts.slice(0, -1).join(' ')
    if (!name || isNaN(price)) return null
    return { name, price }
  }).filter(Boolean)
}

// "4.5 2.13", "-4.5 1.69" → pairs of (line, odds)
function parseLinePairs(btns) {
  const pairs = []
  for (const t of btns) {
    const parts = t.trim().split(/\s+/)
    if (parts.length < 2) continue
    const odds = parseFloat(parts[parts.length - 1])
    const line = parseFloat(parts[parts.length - 2])
    if (!isNaN(line) && !isNaN(odds)) pairs.push({ line, odds })
  }
  return pairs
}

// pairs → handicap ladder [{name, price, point}] (engine spreads format)
// Consecutive pairs: home (+X, odds), away (-X, odds)
function structureHandicap(pairs, homeTeam, awayTeam) {
  const rows = []
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const { line: l1, odds: o1 } = pairs[i]
    const { line: l2, odds: o2 } = pairs[i + 1]
    rows.push({ name: homeTeam, price: o1, point: l1 })
    rows.push({ name: awayTeam, price: o2, point: l2 })
  }
  return rows
}

// pairs → totals ladder [{name, price, point}] (engine totals format)
// Consecutive pairs: Over (line, odds), Under (same line, odds)
function structureTotals(pairs) {
  const rows = []
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const { line, odds: o1 } = pairs[i]
    const { odds: o2 } = pairs[i + 1]
    rows.push({ name: 'Over', price: o1, point: line })
    rows.push({ name: 'Under', price: o2, point: line })
  }
  return rows
}

// "184 1.78" style (no fractional line) → [{name, price, point}]
function structureTotalsSimple(pairs) {
  return structureTotals(pairs)
}

// For extended markets (corners, cards): pairs → clean {name, price, point} array
// "Over 9.5 1.85" style buttons — same structure as totals
function structureExtended(btns) {
  const rows = []
  for (const t of btns) {
    const m = t.match(/(Over|Under)\s+([\d.]+)\s+([\d.]+)/i)
    if (m) {
      rows.push({ name: m[1], price: parseFloat(m[3]), point: parseFloat(m[2]) })
      continue
    }
    // "Yes 1.85" / "No 2.10" (BTTS)
    const m2 = t.match(/^(Yes|No)\s+([\d.]+)$/i)
    if (m2) {
      rows.push({ name: m2[1], price: parseFloat(m2[2]) })
    }
  }
  return rows
}

// ── classify heading → market key ─────────────────────────────────────────

function headingToMarketKey(heading) {
  const h = heading.toLowerCase()
  if (/winner.*overtime|winner.*incl/i.test(h)) return 'h2h'
  if (/match winner|1x2/i.test(h))              return 'h2h'
  if (/handicap/i.test(h))                      return 'spreads'
  if (/total goals|total.*incl|^total/i.test(h)) return 'totals'
  if (/both teams|btts/i.test(h))               return 'btts'
  if (/corners/i.test(h))                       return 'corners'
  if (/cards/i.test(h))                         return 'cards'
  if (/1st goal|first goal/i.test(h))           return 'firstGoal'
  if (/anytime|scorer/i.test(h))                return 'anytimeScorer'
  if (/double chance/i.test(h))                 return 'dc'
  return null
}

// ── main export ───────────────────────────────────────────────────────────

async function scrapeDetailPage(href, sportSlug, { homeTeam = 'Home', awayTeam = 'Away' } = {}) {
  const cfg = SPORTS[sportSlug]
  if (!cfg) throw new Error('Unknown sport: ' + sportSlug)

  const url = 'https://stake.com' + href

  const raw = await withBrowser(async (page) => {
    const result = await page.evaluate(
      new Function('return ' + RAW_JS)(),
      cfg.detailHeadingRe.source
    )
    return result
  }, { url, waitMs: 6000 })

  const markets = {}
  for (const [heading, btns] of Object.entries(raw.sections)) {
    if (!btns.length) continue
    const key = headingToMarketKey(heading)
    if (!key) continue

    // Soccer extended-only mode: skip standard markets (h2h/spreads/totals)
    if (cfg.extendedOnly && ['h2h', 'spreads', 'totals', 'ah', 'dc', 'dnb'].includes(key)) {
      continue
    }

    let parsed = null
    if (key === 'h2h') {
      parsed = parseMoneyline(btns)
    } else if (key === 'spreads') {
      parsed = structureHandicap(parseLinePairs(btns), homeTeam, awayTeam)
    } else if (key === 'totals') {
      parsed = structureTotals(parseLinePairs(btns))
    } else if (key === 'corners' || key === 'cards' || key === 'btts') {
      parsed = structureExtended(btns)
      if (!parsed.length) parsed = structureTotals(parseLinePairs(btns))
    } else {
      // player props, firstGoal etc. — keep as raw labels
      parsed = btns.map(t => {
        const m = t.match(/(.+?)\s+([\d.]+)$/)
        return m ? { name: m[1].trim(), price: parseFloat(m[2]) } : null
      }).filter(Boolean)
    }

    if (parsed && parsed.length) markets[key] = parsed
  }

  return { markets, _title: raw.title, _headings: raw.headings }
}

module.exports = { scrapeDetailPage }
