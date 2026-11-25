// zqLeagues.js — maps ZQ Chinese league names (league_name field) to a stable
// engine sportKey + English display label. ZQ matches become bettable events keyed
// under these sportKeys so they show as their own chips under Football.
//
// Any ZQ league not listed here still becomes bettable under a generated key
// "zq_other_<slug>" with the raw (or translated) name — nothing is dropped.
// Keep this list growing as new ZQ leagues appear.

const ZQ_LEAGUE_MAP = {
  '挪超':   { key: 'zq_norway_eliteserien',   label: 'Norwegian Eliteserien' },
  '阿甲':   { key: 'zq_argentina_primera',    label: 'Argentine Primera' },
  '南美杯': { key: 'zq_copa_sudamericana',    label: 'Copa Sudamericana' },
  '解放者杯': { key: 'zq_copa_libertadores',  label: 'Copa Libertadores' },
  '芬超':   { key: 'zq_finland_veikkausliiga',label: 'Finnish Veikkausliiga' },
  '芬甲':   { key: 'zq_finland_ykkonen',      label: 'Finnish Ykkonen' },
  '巴甲':   { key: 'zq_brazil_serie_a',       label: 'Brazil Serie A' },
  '巴西杯': { key: 'zq_brazil_cup',           label: 'Brazil Cup' },
  '瑞典超': { key: 'zq_sweden_allsvenskan',   label: 'Swedish Allsvenskan' },
  '瑞典甲': { key: 'zq_sweden_superettan',    label: 'Swedish Superettan' },
  '美职联': { key: 'zq_usa_mls',              label: 'MLS' },
  '挪威杯': { key: 'zq_norway_cup',           label: 'Norwegian Cup' },
  '日职联': { key: 'zq_japan_jleague',        label: 'J-League' },
  '日职乙': { key: 'zq_japan_j2',             label: 'J2 League' },
  '韩K联':  { key: 'zq_korea_kleague',        label: 'K-League' },
  '欧罗巴': { key: 'zq_europa_league',        label: 'Europa League' },
  '欧联杯': { key: 'zq_europa_league',        label: 'Europa League' },
  '欧冠':   { key: 'zq_champions_league',     label: 'Champions League' },
  '欧协联': { key: 'zq_conference_league',    label: 'Conference League' },
  '球会友谊': { key: 'zq_club_friendly',      label: 'Club Friendly' },
}

function slug(s) {
  return String(s || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'x'
}

// Resolve a ZQ league_name -> { key, label }. Unknown leagues get a generated key
// (still bettable). enLabel is an optional already-translated fallback name.
function resolveLeague(cnName, enLabel) {
  if (ZQ_LEAGUE_MAP[cnName]) return ZQ_LEAGUE_MAP[cnName]
  const label = (enLabel && enLabel.trim()) || cnName || 'Intl'
  return { key: 'zq_other_' + slug(enLabel || cnName), label }
}

// All known ZQ league keys (for config chip generation / validation).
function allKeys() {
  return [...new Set(Object.values(ZQ_LEAGUE_MAP).map(v => v.key))]
}

module.exports = { ZQ_LEAGUE_MAP, resolveLeague, allKeys, slug }
