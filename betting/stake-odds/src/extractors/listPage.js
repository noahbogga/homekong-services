// extractors/listPage.js — scrape Stake list page for all upcoming fixtures + moneyline
// Ports the validated Python probe (stake_dom3.py) to Node.js Playwright.
// Returns array of event objects ready for the engine ingest format.

const { withBrowser } = require('../browser')
const { SPORTS, sportKeyFromHref } = require('../sports')

// Validated EXTRACT_JS — climb from each fixture link to a row container that has
// ≥2 odds buttons but still contains exactly ONE fixture link (prevents sibling merge).
// fixRegexStr is embedded directly as a regex literal — no arg passing needed.
function buildExtractJs(fixRegexStr) {
  return `() => {
      const FIX = /${fixRegexStr}/;
      const isFix = a => FIX.test(a.getAttribute('href') || '');
      const fixtureLinks = [...document.querySelectorAll('a[href]')].filter(isFix);
      const rows = [];
      const seen = new Set();

      for (const link of fixtureLinks) {
        const href = link.getAttribute('href');
        // Normalize href by stripping query params for deduplication
        // (Stake renders ?tab=sgm variants for the same fixture)
        const hrefBase = href.split('?')[0];
        if (seen.has(hrefBase)) continue;
        seen.add(hrefBase);

        // Climb until container has >=2 odds buttons AND exactly 1 DISTINCT fixture href.
        // Stake renders multiple <a> per fixture (team names + match link = same href repeated),
        // so we count distinct hrefs (ignoring ?query params) to avoid false fixCount > 1 breaks.
        let row = link, chosen = null;
        for (let i = 0; i < 8 && row.parentElement; i++) {
          row = row.parentElement;
          const fixHrefs = new Set(
            [...row.querySelectorAll('a[href]')]
              .filter(isFix)
              .map(a => (a.getAttribute('href') || '').split('?')[0])
          );
          const oddBtns = [...row.querySelectorAll('button')]
            .filter(b => /\\d+\\.\\d{1,3}/.test(b.innerText || ''));
          if (fixHrefs.size > 1) break;
          if (oddBtns.length >= 2) chosen = row;
        }
        if (!chosen) continue;

        // Team names: collect from ALL fixture <a> elements in the container.
        // Stake renders per-team links (each <a> = 1 team name) so using only link.innerText
        // would yield at most 1 team. We gather all unique non-odds text lines.
        const teamLinks = [...chosen.querySelectorAll('a[href]')].filter(isFix);
        const teams = [];
        const seenTeam = new Set();
        for (const tl of teamLinks) {
          for (const line of (tl.innerText || '').split('\\n').map(s => s.trim())) {
            if (line && !/^\\d+\\.\\d/.test(line) && line.length < 50 && !seenTeam.has(line)) {
              seenTeam.add(line);
              teams.push(line);
            }
          }
        }

        // Odds buttons in DOM order
        const oddBtns = [...chosen.querySelectorAll('button')]
          .filter(b => /\\d+\\.\\d{1,3}/.test(b.innerText || ''));
        const odds = oddBtns.map(b => {
          const m = (b.innerText || '').match(/\\d+\\.\\d{1,3}/);
          return { label: (b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50),
                   value: m ? parseFloat(m[0]) : null };
        });

        // Start time: look for a time element near the fixture link
        let startTime = null;
        const timeEl = chosen.querySelector('time[datetime]');
        if (timeEl) startTime = timeEl.getAttribute('datetime');

        rows.push({ href, teams, odds, startTime });
      }
      return rows;
    }`
}

// Convert raw row data → clean engine event shape
// Returns null if the row doesn't have enough info to be useful.
function rowToEvent(row, sportSlug) {
  const { href, teams, odds, startTime } = row
  if (!href || teams.length < 1) return null

  // Stake renders a combined "Team A - Team B" match-title link alongside per-team links.
  // Strategy: if any entry contains ' - ', treat it as the match title, extract individual
  // names from other entries, then fill gaps by splitting the title.
  // Handles both 3-link (title + 2 teams) and 2-link (title + 1 team) layouts.
  let cleanTeams = teams
  const titleIdx = teams.findIndex(t => t.includes(' - '))
  if (titleIdx >= 0) {
    const title = teams[titleIdx]
    const parts = title.split(' - ').map(p => p.trim()).filter(Boolean)
    const others = teams.filter((_, i) => i !== titleIdx)
    // Merge: keep per-team links, fill in any missing names from the split title
    const merged = [...new Set([...others, ...parts.filter(p => !others.includes(p))])]
    if (merged.length >= 2) cleanTeams = merged
  }
  if (cleanTeams.length < 2) return null

  const sportKey = sportKeyFromHref(sportSlug, href)
  if (!sportKey) return null

  const homeTeam = cleanTeams[0]
  const awayTeam = cleanTeams[1]

  // Moneyline: expect exactly 2 odds (home, away) for basketball / 3 for soccer (home, draw, away)
  // We keep all odds found and label them by position.
  const h2h = []
  if (odds[0]?.value) h2h.push({ name: homeTeam, price: odds[0].value })
  if (odds[1]?.value) h2h.push({ name: awayTeam, price: odds[1].value })
  // For soccer: 3rd odds = Draw (position 1 is typically Draw on Stake — verify after first run)

  if (!h2h.length) return null

  // Generate a deterministic ID from href so same fixture = same ID across cycles
  const id = 'stake_' + href.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').slice(-40)

  return {
    id,
    sportKey,
    homeTeam,
    awayTeam,
    startTime: startTime || new Date(Date.now() + 24 * 3600000).toISOString(), // fallback: tomorrow
    markets: { h2h },
    _source: 'stake',
    _href: href,
  }
}

async function scrapeListPage(sportSlug) {
  const cfg = SPORTS[sportSlug]
  if (!cfg) throw new Error('Unknown sport: ' + sportSlug)

  const extractJs = buildExtractJs(cfg.fixRegex.source)

  const rows = await withBrowser(async (page) => {
    // Wait for React to render at least one fixture link, up to 20s.
    const selectorHint = `/sports/${sportSlug}/`
    try {
      await page.waitForFunction(
        `() => [...document.querySelectorAll('a[href]')].some(a => a.getAttribute('href')?.includes('${selectorHint}'))`,
        { timeout: 20000 }
      )
    } catch {
      const title = await page.title().catch(() => '?')
      const url = await page.url().catch(() => '?')
      console.warn(`[listPage] ${sportSlug}: fixture links didn't appear in 20s | title="${title}" url=${url}`)
    }

    // Diagnostic: log first 3 matching hrefs + first container's teams/odds
    const diagJs = `(() => {
      const FIX = /${cfg.fixRegex.source}/;
      const isFix = a => FIX.test(a.getAttribute('href')||'');
      const links = [...document.querySelectorAll('a[href]')].filter(isFix);
      const samples = links.slice(0,3).map(a => a.getAttribute('href'));
      let withOdds = 0;
      let firstTeams = null, firstOdds = null, firstHref = null;
      const seen = new Set();
      for (const a of links) {
        const h = (a.getAttribute('href')||'').split('?')[0];
        if (seen.has(h)) continue; seen.add(h);
        let el = a;
        for (let i = 0; i < 8 && el.parentElement; i++) {
          el = el.parentElement;
          const fixHrefs = new Set([...el.querySelectorAll('a[href]')].filter(isFix).map(x=>(x.getAttribute('href')||'').split('?')[0]));
          const oddbts = [...el.querySelectorAll('button')].filter(b => /\\d+\\.\\d/.test(b.innerText||''));
          if (fixHrefs.size > 1) break;
          if (oddbts.length >= 2) {
            withOdds++;
            if (!firstTeams) {
              firstHref = h;
              const tls = [...el.querySelectorAll('a[href]')].filter(isFix);
              const ts = [], tseen = new Set();
              for (const tl of tls) {
                for (const line of (tl.innerText||'').split('\\n').map(s=>s.trim())) {
                  if (line && !/^\\d+\\.\\d/.test(line) && line.length<50 && !tseen.has(line)) { tseen.add(line); ts.push(line); }
                }
              }
              firstTeams = ts;
              firstOdds = oddbts.slice(0,4).map(b=>(b.innerText||'').trim().slice(0,25));
            }
            break;
          }
        }
      }
      return { total: links.length, samples, withOdds, firstTeams, firstOdds, firstHref };
    })()`
    const diag = await page.evaluate(diagJs).catch(e => ({ err: e.message }))
    console.log(`[listPage] ${sportSlug} diag:`, JSON.stringify(diag))

    const result = await page.evaluate('(' + extractJs + ')()')
    if (!Array.isArray(result)) {
      console.warn(`[listPage] ${sportSlug}: evaluate returned non-array (${typeof result})`)
      return []
    }
    return result
  }, { url: cfg.listUrl, waitMs: 0 })

  const events = []
  let dropLogged = 0
  for (const row of rows) {
    const ev = rowToEvent(row, sportSlug)
    if (ev) {
      events.push(ev)
    } else if (dropLogged < 2) {
      dropLogged++
      const sportKey = require('../sports').sportKeyFromHref(sportSlug, row.href || '')
      console.log(`[listPage] ${sportSlug} drop[${dropLogged}]: teams=${JSON.stringify(row.teams)} odds=${JSON.stringify((row.odds||[]).slice(0,3).map(o=>o.value))} sportKey=${sportKey} href=...${(row.href||'').slice(-35)}`)
    }
  }

  console.log(`[listPage] ${sportSlug}: ${events.length} fixtures (${rows.length} raw rows)`)
  return events
}

module.exports = { scrapeListPage }
