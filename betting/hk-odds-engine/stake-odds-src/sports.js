// sports.js — per-sport config: Stake URLs, market heading patterns, engine sportKey mappings
// Add new sports here without touching extraction logic.

const SPORTS = {
  basketball: {
    listUrl: 'https://stake.com/sports/basketball',
    // Regex to identify fixture links (3 segments: country/league/fixture) — excludes league pages
    fixRegex: /\/sports\/basketball\/[\w-]+\/[\w-]+\/[\w-]+/,
    // Market headings on the fixture detail page (regex)
    detailHeadingRe: /(Winner|Handicap|Total)\s*\(Incl\. Overtime\)/i,
    // Stake URL slug → engine sportKey.
    // Matched against the fixture href: /sports/basketball/<league-slug>/...
    leagueMap: {
      'wnba':        'basketball_wnba',
      'nba':         'basketball_nba',
      'euroleague':  'basketball_euroleague',
    },
    defaultKey: 'basketball_other',
    // Stake is the PRIMARY source for basketball — ingest as replace
    ingestMode: 'replace',
    // Pull detail page for ALL fixtures (not just hot) since we're primary
    detailAll: true,
  },

  soccer: {
    listUrl: 'https://stake.com/sports/soccer',
    fixRegex: /\/sports\/soccer\/[\w-]+\/[\w-]+\/[\w-]+/,
    // Basketball uses "Incl. Overtime"; soccer uses different heading names.
    // These are best-guesses — adjust after first live soccer scrape.
    detailHeadingRe: /(Match Winner|1X2|Asian Handicap|Total Goals|Both Teams|Total Corners|Total Cards|1st Goal|Anytime)/i,
    leagueMap: {
      'english-premier-league': 'soccer_epl',
      'la-liga':                'soccer_spain_la_liga',
      'bundesliga':             'soccer_germany_bundesliga',
      'serie-a':                'soccer_italy_serie_a',
      'ligue-1':                'soccer_france_ligue_one',
      'champions-league':       'soccer_uefa_champs_league',
      'europa-league':          'soccer_uefa_europa_league',
      'championship':           'soccer_efl_champ',
      'mls':                    'soccer_usa_mls',
    },
    defaultKey: null,   // null = skip if league unmapped (don't pollute cache)
    // ZQ owns standard soccer markets — Stake only adds extended markets
    ingestMode: 'merge',
    // For soccer, only scrape detail pages for hot matches (proxy cost)
    detailAll: false,
    // Which Stake market headings to ingest (everything EXCEPT standard 1X2/AH/totals
    // that ZQ already provides). Stake-exclusive markets only.
    extendedOnly: true,
    extendedHeadingRe: /(Total Corners|Total Cards|Both Teams|1st Goal|Anytime|Double Chance)/i,
  },
}

// Derive engine sportKey from a fixture href.
function sportKeyFromHref(sportSlug, href) {
  const cfg = SPORTS[sportSlug]
  if (!cfg) return null
  // href like: /sports/soccer/english-premier-league/man-city-vs-arsenal/12345
  const parts = href.split('/')
  // parts[3] = sport, parts[4] = league slug
  const leagueSlug = parts[4] || ''
  return cfg.leagueMap[leagueSlug] || cfg.defaultKey
}

module.exports = { SPORTS, sportKeyFromHref }
