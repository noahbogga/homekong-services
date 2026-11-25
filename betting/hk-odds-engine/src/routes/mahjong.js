// ═══════════════════════════════════════════════════════════════════════════
// MAHJONG — live multiplayer online mahjong (Phase 1: Hong Kong Old Style)
//
// Same model as blackjack/crash: ALL game logic lives here; the FiveM resource
// is the MONEY authority. Unlike blackjack (bet-per-round), mahjong is chip
// based — a player escrows a BUY-IN when they join a lobby, the engine tracks
// their chip stack across hands, and the relay cashes the remaining stack out
// on leave. Money touches the DB only on buy-in and cash-out, not per hand.
//
// Lobbies are player-created and public (max MAX_LOBBIES). Each lobby picks a
// style (Phase 1 = hk_old only), a base bet (底), and an optional 4-digit
// password. Empty seats are filled by house-funded AI bots.
//
// Provably fair: a 144-tile wall (136 base + 8 bonus) is Fisher-Yates shuffled
// deterministically from HMAC-SHA256(serverSeed, clientSeed:handNonce:cursor).
// serverSeedHash is committed at hand start; the seed is revealed at hand end
// so the whole wall order can be reconstructed and verified.
//
// Win detection + faan scoring are delegated to the `hk-mahjong` library
// (MIT). We convert our compact tile ints to its Tile objects, form the
// exposed melds, and let Hand.isAbleToGroupAsMelds() / FaanCalculator do the
// heavy lifting. HK Old Style goes out at a 3-faan minimum (三番起糊).
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const crypto = require('crypto')
const { Tile, Meld, Hand, FaanCalculator } = require('hk-mahjong')

const router = express.Router()

// ─── Crypto (mirror of blackjack.js / crypto.lua) ───────────────────────────
function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex')
}
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}
function generateGameHash(serverSeed, clientSeed, nonce, cursor = 0) {
  return hmacSha256(serverSeed, `${clientSeed}:${nonce}:${cursor}`)
}
function floatFromHash(hash, cursor) {
  const idx = cursor * 8
  let h = hash
  if (idx + 8 > h.length) {
    h = sha256(hash + ':' + String(cursor))
    return parseInt(h.substring(0, 8), 16) / 0x100000000
  }
  return parseInt(h.substring(idx, idx + 8), 16) / 0x100000000
}
// ─── Tiles ───────────────────────────────────────────────────────────────
// A tile is a compact integer. Suit tiles 0..26, honors 27..33 (four of each,
// 34 kinds × 4 = 136), bonus tiles 34..41 (one of each, 8). Grand wall = 144.
//   0..8   characters (萬) 1..9
//   9..17  bamboo     (索) 1..9
//   18..26 dots       (筒) 1..9
//   27..30 winds  East / South / West / North
//   31..33 dragons Red(中) / Green(發) / White(白)
//   34..37 flowers Plum / Orchid / Chrysanthemum / Bamboo
//   38..41 seasons Spring / Summer / Autumn / Winter
const KIND_COUNT = 34            // distinct base kinds (each appears 4×)
const BASE_TILES = 136           // 34 × 4
const BONUS_BASE = 34            // first bonus tile code
const WALL_SIZE = 144            // 136 base + 8 bonus

const WINDS = ['east', 'south', 'west', 'north']   // honor 1..4
const WIND_LABEL = ['East', 'South', 'West', 'North']
const DRAGON_LABEL = ['Red', 'Green', 'White']     // 中 發 白
const FLOWER_LABEL = ['Plum', 'Orchid', 'Chrys', 'Bamboo']
const SEASON_LABEL = ['Spring', 'Summer', 'Autumn', 'Winter']

function isBonus(code) { return code >= BONUS_BASE }
function isFlower(code) { return code >= 34 && code <= 37 }
function isSeason(code) { return code >= 38 && code <= 41 }

// kind index 0..33 for a base tile (bonus tiles have no kind).
function kindOf(code) { return code }

// Convert a base tile int → hk-mahjong Tile. Bonus tiles are never passed here
// (they are set aside on draw, never part of the scored hand).
function toLibTile(code) {
  if (code <= 8)  return new Tile({ suit: 'character', value: code + 1 })
  if (code <= 17) return new Tile({ suit: 'bamboo', value: code - 9 + 1 })
  if (code <= 26) return new Tile({ suit: 'dot', value: code - 18 + 1 })
  if (code <= 33) return new Tile({ suit: 'honor', value: code - 27 + 1 })  // 27→1(E)..33→7(白)
  throw new Error('bonus tile has no lib representation: ' + code)
}

// Human label for the UI (English game per spec). Suit tiles → "5m/3s/7p",
// honors + bonus spelled out.
function tileLabel(code) {
  if (code <= 8)  return (code + 1) + 'm'          // man / characters
  if (code <= 17) return (code - 9 + 1) + 's'      // sou / bamboo
  if (code <= 26) return (code - 18 + 1) + 'p'     // pin / dots
  if (code <= 30) return WIND_LABEL[code - 27]
  if (code <= 33) return DRAGON_LABEL[code - 31]
  if (code <= 37) return 'F:' + FLOWER_LABEL[code - 34]
  return 'S:' + SEASON_LABEL[code - 38]
}

// Suit family for grouping/melding logic. 0 char, 1 bam, 2 dot, 3 honor, 4 bonus.
function familyOf(code) {
  if (code <= 8) return 0
  if (code <= 17) return 1
  if (code <= 26) return 2
  if (code <= 33) return 3
  return 4
}
// Numeric value within a suit family (1..9), or 0 for honors/bonus.
function numOf(code) {
  const f = familyOf(code)
  if (f === 0) return code + 1
  if (f === 1) return code - 9 + 1
  if (f === 2) return code - 18 + 1
  return 0
}
function isSuited(code) { return familyOf(code) <= 2 }
function isTerminal(code) { return isSuited(code) && (numOf(code) === 1 || numOf(code) === 9) }

// Build an ordered 144-tile wall, then Fisher-Yates shuffle deterministically
// from the fair stream. Cursor advances once per swap so the whole permutation
// is reconstructible from (serverSeed, clientSeed, handNonce).
function buildWall(serverSeed, clientSeed, nonce) {
  const wall = []
  for (let k = 0; k < KIND_COUNT; k++) for (let c = 0; c < 4; c++) wall.push(k)  // 136
  for (let b = BONUS_BASE; b < BONUS_BASE + 8; b++) wall.push(b)                 // 8 bonus
  const hash = generateGameHash(serverSeed, clientSeed, nonce)
  for (let i = wall.length - 1; i > 0; i--) {
    const f = floatFromHash(hash, wall.length - 1 - i)
    const j = Math.floor(f * (i + 1))
    const t = wall[i]; wall[i] = wall[j]; wall[j] = t
  }
  return wall
}
// ─── Hand analysis (bridge to hk-mahjong) ──────────────────────────────────
// A player's state during a hand:
//   concealed: int[]  tiles in hand (13 between turns, 14 on own draw)
//   melds:     [{ type:'chow'|'pung'|'kong', tiles:int[], concealed?:bool }]
//   bonuses:   int[]  flowers/seasons set aside (score bonus faan, never in hand)
// Exposed melds are locked; win detection only permutes the concealed tiles.

// Count occurrences of each base-tile kind in an int array.
function counts(tiles) {
  const c = new Array(KIND_COUNT).fill(0)
  for (const t of tiles) if (!isBonus(t)) c[t]++
  return c
}

// Build an hk-mahjong Hand from concealed tiles + exposed melds.
// Bonus tiles are excluded (never part of the scored structure).
function buildLibHand(concealed, melds) {
  const tiles = concealed.filter(t => !isBonus(t)).map(toLibTile)
  const libMelds = (melds || []).map(m => new Meld(m.tiles.map(toLibTile)))
  return new Hand({ tiles, melds: libMelds.length ? libMelds : undefined })
}

// Structural win check: do concealed + exposed melds group into 4 melds + eyes?
// This ignores the faan threshold (used to test go-out legality separately).
function isStructuralWin(concealed, melds) {
  try {
    // Total tile count must be 14, 15 (one kong), 16 (two kongs)… i.e. 14 + kongs.
    const kongCount = (melds || []).filter(m => m.type === 'kong').length
    const total = concealed.filter(t => !isBonus(t)).length +
      (melds || []).reduce((a, m) => a + m.tiles.length, 0)
    if (total !== 14 + kongCount) return false
    return buildLibHand(concealed, melds).isAbleToGroupAsMelds()
  } catch (e) { return false }
}

// Best faan over all winning permutations, honoring seat/round wind + context
// (self-pick, robbing kong, etc.) + bonus tiles. Returns { faan, detail }.
function scoreHand(concealed, melds, bonuses, ctx) {
  let hand
  try { hand = buildLibHand(concealed, melds) } catch (e) { return { faan: 0, detail: [] } }
  const perms = hand.findAllWinningPermutations()
  if (!perms.length) return { faan: 0, detail: [] }
  const config = {
    selfPick: !!ctx.selfPick,
    robbingKong: !!ctx.robbingKong,
    winByLastCatch: !!ctx.winByLastCatch,
    winByKong: !!ctx.winByKong,
    seatWind: ctx.seatWind,
    roundWind: ctx.roundWind,
  }
  // Fold bonus tiles into the library's flower/season config so 花牌 faan count.
  if (bonuses && bonuses.length) {
    const ex = { spring: false, summer: false, autumn: false, winter: false,
      plum: false, lily: false, chrysanthemum: false, bamboo: false }
    for (const b of bonuses) {
      if (b === 34) ex.plum = true
      else if (b === 35) ex.lily = true          // orchid ↔ lily slot
      else if (b === 36) ex.chrysanthemum = true
      else if (b === 37) ex.bamboo = true
      else if (b === 38) ex.spring = true
      else if (b === 39) ex.summer = true
      else if (b === 40) ex.autumn = true
      else if (b === 41) ex.winter = true
    }
    config.extraTiles = ex
  }
  let best = -1, detail = []
  for (const p of perms) {
    let r
    try { r = FaanCalculator.calculate(p, config) } catch (e) { continue }
    const v = r.value === '∞' ? 999 : r.value
    if (v > best) { best = v; detail = r.details }
  }
  return { faan: Math.max(0, best), detail }
}

// Does adding `tile` to the concealed hand (+ existing melds) make a legal win
// that clears the go-out threshold? Used to validate a discard/self-draw claim.
function wouldWin(concealed, melds, bonuses, tile, ctx, threshold) {
  const hand14 = concealed.concat([tile])
  if (!isStructuralWin(hand14, melds)) return null
  // No faan gate (PaoMaJai 推倒糊, threshold 0): any legal structure wins, so
  // skip the expensive permutation-scoring pass entirely.
  if (!threshold) return { faan: 0, detail: [] }
  const { faan, detail } = scoreHand(hand14, melds, bonuses, ctx)
  if (faan < threshold) return null
  return { faan, detail }
}

// ── Claim legality on the concealed hand ──
// Chow: needs two tiles that sequence with `tile` in the same suit (only from
// the player to the left / upstream — enforced by caller). Returns the set of
// possible chow completions as arrays of the two concealed tiles to use.
function chowOptions(concealed, tile) {
  if (!isSuited(tile)) return []
  const n = numOf(tile), fam = familyOf(tile)
  const base = tile - (n - 1)                       // suit's "1" code
  const has = v => (v >= 1 && v <= 9) && concealed.includes(base + (v - 1))
  const codeOf = v => base + (v - 1)
  const opts = []
  if (has(n - 2) && has(n - 1)) opts.push([codeOf(n - 2), codeOf(n - 1)])
  if (has(n - 1) && has(n + 1)) opts.push([codeOf(n - 1), codeOf(n + 1)])
  if (has(n + 1) && has(n + 2)) opts.push([codeOf(n + 1), codeOf(n + 2)])
  return opts.filter(pair => fam === familyOf(pair[0]))
}
function canPung(concealed, tile) {
  return !isBonus(tile) && counts(concealed)[tile] >= 2
}
// Open kong off a discard (need 3 in hand); or added kong onto own pung (melded).
function canKongFromDiscard(concealed, tile) {
  return !isBonus(tile) && counts(concealed)[tile] >= 3
}
// Concealed kong from own hand (4 in hand, on own turn).
function concealedKongs(concealed) {
  const c = counts(concealed)
  const out = []
  for (let k = 0; k < KIND_COUNT; k++) if (c[k] === 4) out.push(k)
  return out
}

// ─── Shanten / ukeire (bot brain, Phase 2) ──────────────────────────────────
// Shanten = how many tile swaps away a hand is from a complete (tenpai→win)
// structure. -1 = complete, 0 = tenpai (one tile from winning), higher = worse.
// We count over a 34-length tile histogram, treating each already-melded set as
// one locked meld. This is the standard recursive meld/partial decomposition
// used by efficiency bots (AlphaJong et al.), adapted to our tile encoding and
// to the fact that PaoMaJai has no yaku gate (any 4 sets + pair wins).
//
// `needMelds` is 4 minus exposed melds; `c` is a mutable 34-count array of the
// concealed tiles. Returns the minimum shanten for a standard hand.
function stdShanten(c, needMelds) {
  let best = 8
  // Try each tile as the pair (eyes), plus the no-pair case, and recurse.
  const recurse = (idx, melds, partials, hasPair) => {
    while (idx < KIND_COUNT && c[idx] === 0) idx++
    if (idx >= KIND_COUNT) {
      // Blocks toward the 4-melds+pair target. Cap partials at the melds we
      // still need; the pair reservation removes one more step.
      let usefulPartials = partials
      if (melds + partials > needMelds) usefulPartials = needMelds - melds
      const sh = (needMelds - melds) * 2 - usefulPartials - (hasPair ? 1 : 0)
      if (sh < best) best = sh
      return
    }
    // Option A: complete triplet (pung) — only while we still need melds.
    if (c[idx] >= 3 && melds < needMelds) {
      c[idx] -= 3; recurse(idx, melds + 1, partials, hasPair); c[idx] += 3
    }
    // Option B: run (chow) — suited only, same family, while melds still needed.
    if (melds < needMelds && isSuited(idx) && numOf(idx) <= 7 &&
        familyOf(idx) === familyOf(idx + 1) && familyOf(idx) === familyOf(idx + 2) &&
        c[idx + 1] > 0 && c[idx + 2] > 0) {
      c[idx]--; c[idx + 1]--; c[idx + 2]--
      recurse(idx, melds + 1, partials, hasPair)
      c[idx]++; c[idx + 1]++; c[idx + 2]++
    }
    // Option C: pair — either as the eyes, or as a partial toward a pung.
    if (c[idx] >= 2) {
      if (!hasPair) {
        c[idx] -= 2; recurse(idx, melds, partials, true); c[idx] += 2   // reserve as eyes
      }
      if (melds + partials < needMelds) {
        c[idx] -= 2; recurse(idx, melds, partials + 1, hasPair); c[idx] += 2  // toward a pung
      }
    }
    // Option D: partial run (ryanmen/kanchan/penchan) — two tiles that need one.
    if (isSuited(idx) && melds + partials < needMelds) {
      if (numOf(idx) <= 8 && familyOf(idx) === familyOf(idx + 1) && c[idx + 1] > 0) {
        c[idx]--; c[idx + 1]--; recurse(idx, melds, partials + 1, hasPair); c[idx]++; c[idx + 1]++
      }
      if (numOf(idx) <= 7 && familyOf(idx) === familyOf(idx + 2) && c[idx + 2] > 0) {
        c[idx]--; c[idx + 2]--; recurse(idx, melds, partials + 1, hasPair); c[idx]++; c[idx + 2]++
      }
    }
    // Option E: skip one copy of this tile (leave it floating).
    c[idx]--; recurse(idx, melds, partials, hasPair); c[idx]++
  }
  recurse(0, 0, 0, false)
  return best
}

// Shanten of a full hand state (concealed histogram + exposed meld count).
function handShanten(concealed, melds) {
  const c = counts(concealed)
  const exposed = (melds || []).length
  return stdShanten(c, 4 - exposed)
}

// Ukeire: the set of tile kinds that, if drawn, REDUCE shanten — plus how many
// such tiles remain unseen. Wider ukeire = a faster hand. `seen` is a 34-count
// of every tile this seat can account for (its own hand + melds + all discards
// + others' exposed melds); unseen copies = 4 − seen.
function ukeire(concealed, melds, seen) {
  const base = handShanten(concealed, melds)
  const c = counts(concealed)
  const tiles = []
  let total = 0
  for (let k = 0; k < KIND_COUNT; k++) {
    if (c[k] >= 4) continue                     // can't draw a 5th
    c[k]++
    const sh = stdShanten(c, 4 - (melds || []).length)
    c[k]--
    if (sh < base) {
      const remain = Math.max(0, 4 - (seen ? seen[k] : 0))
      if (remain > 0) { tiles.push(k); total += remain }
    }
  }
  return { shanten: base, tiles, count: total }
}

// Everything this seat can "see" — used for ukeire remaining-count + discard
// safety. Own concealed + own melds + all discards + everyone's exposed melds.
function seenCounts(l, seat) {
  const seen = new Array(KIND_COUNT).fill(0)
  const add = t => { if (!isBonus(t)) seen[t]++ }
  for (const t of seat.hand) add(t)
  for (const s of l.seats) {
    if (!s.identifier) continue
    for (const d of s.discards) add(d)
    for (const m of s.melds) for (const t of m.tiles) add(t)
  }
  return seen
}

// ─── Styles & config ───────────────────────────────────────────────────────
// Phase 1 ships hk_old only. The others are declared so the NUI picker + relay
// can show them "coming soon"; the engine refuses to start a lobby on a style
// whose ruleset isn't implemented yet.
const STYLES = {
  hk_old: {
    id: 'hk_old', name: 'Hong Kong Old Style', enabled: true,
    scoring: 'faan',             // faan-ladder scorer (settleWin faan branch)
    handTiles: 13,               // 13 in hand, draw to 14
    goOutFaan: 3,                // 三番起糊 — minimum faan to declare a win
    limitFaan: 13,               // 爆棚 cap (滿糊 at limitFaan units)
    bonusTiles: true,            // flowers + seasons in the wall
    allowChow: true,             // may chow off a discard
    chowFromLeftOnly: true,      // chow only off the upstream (left) discard
    // faan → payout units. Below goOutFaan you cannot win. Classic HK doubling
    // ladder, capped at the limit hand.
    faanUnits: { 3: 1, 4: 2, 5: 4, 6: 8, 7: 16, 8: 32, 9: 48, 10: 64, 11: 96, 12: 128, 13: 192 },
  },
  // 跑馬仔 / 碰槓牌 — modern HK casino mode. Fundamentally different from hk_old:
  // NO faan (any 4-melds+pair wins, 推倒糊), flat unit payouts, kong income
  // collected immediately & independent of the win (a winner can still be net
  // negative), and the 獎馬 horse bonus on self-draw. No round/seat winds; the
  // winner deals next. Chow is NOT claimable (可碰不可吃) — concealed runs still
  // count in a self-drawn hand, you just cannot chow off a discard.
  paomajai: {
    id: 'paomajai', name: 'PaoMaJai (跑馬仔)', enabled: true,
    scoring: 'paomajai',
    handTiles: 13,
    goOutFaan: 0,                // any legal 4-melds+pair structure wins
    bonusTiles: true,
    allowChow: false,            // 可碰不可吃
    chowFromLeftOnly: true,      // (unused while allowChow=false, kept for parity)
    winnerDeals: true,           // winner becomes next dealer; multi-ron → 富貴莊
    noRoundWind: true,           // 無圈風場風
    // Flat payouts in base-bet units (底/籌).
    units: { ron: 2, selfDrawEach: 2 },
    // Kong income (collected immediately, separate from the win):
    //   concealed 暗槓 → each other player pays 2
    //   bigMing   大明槓 (kong the 4th off a discard) → the discarder pays 3
    //   added     加槓 (upgrade an exposed pung) → each other player pays 1
    kong: { concealed: 2, bigMing: 3, added: 1 },
    // 獎馬: self-draw only. Flip (base + perKong × winner's kongs) wall tiles;
    // each matching the winner's seat-position horse set pays another self-draw
    // round (selfDrawEach from every other player). chart: 'mode2' (default,
    // balanced 10-kinds-each) | 'mode1' (一龍一位). See horseSetFor().
    horses: { base: 1, perKong: 1, chart: 'mode2' },
  },
  // Placeholders (Phase 3) — enabled:false so start() rejects them for now.
  tw_16:      { id: 'tw_16', name: 'Taiwanese 16', enabled: false },
  sc_bloody:  { id: 'sc_bloody', name: 'Sichuan Bloody', enabled: false },
  riichi:     { id: 'riichi', name: 'Riichi (Japanese)', enabled: false },
}

const MAX_LOBBIES = 16
const SEATS = 4
const BASE_BET_MIN = 10           // $ per payout unit (底)
const BASE_BET_MAX = 100000       // global cap on the base bet
const BUYIN_UNITS = 200           // required buy-in = baseBet × this (chip stack)
const RAKE_PCT = 0.01             // 1% rake on full-human tables

// Pacing (seconds unless _MS)
const CLAIM_WINDOW = 6            // seconds others may claim a discard (extra room to react to pung/chow/win)
const TURN_TIME = 20             // seconds to draw+discard before auto-play
const DEAL_STEP_MS = 60          // between paced deal reveals
const HAND_HOLD = 8             // seconds the finished board stays before next hand
const START_COUNTDOWN = 3        // seconds after host presses start before dealing
// Bots deliberate for a randomised human-ish spell rather than a fixed beat —
// a constant delay makes every seat fire in perfect lockstep, which reads as
// "rigged." botThinkMs() returns a jittered pause; harder decisions (claims,
// self-draw wins) get a slightly longer, more variable "considering" pause.
const BOT_THINK_MIN_MS = 900      // fastest a bot ever acts
const BOT_THINK_MAX_MS = 2600     // slowest a routine discard
function botThinkMs(kind) {
  // kind: 'turn' | 'claim'. Claims must land inside the claim window, so they
  // stay snappier; turns get the full spread. Triangular-ish: two uniforms
  // averaged, biasing toward the middle so most moves feel unhurried but not
  // metronomic, with the occasional quick or slow one.
  const lo = kind === 'claim' ? 500 : BOT_THINK_MIN_MS
  const hi = kind === 'claim' ? 1800 : BOT_THINK_MAX_MS
  const r = (Math.random() + Math.random()) / 2
  return Math.floor(lo + r * (hi - lo))
}

// ─── Bot difficulty profiles ────────────────────────────────────────────────
// AlphaJong-style knobs. Each bot decision scores candidate moves and the
// profile scales how much the bot cares about pure efficiency (winning fast)
// vs safety (not feeding a dangerous discard), plus how often it deliberately
// plays a sub-optimal tile so it doesn't feel robotic.
//   efficiency — weight on ukeire/shanten gain when choosing a discard
//   safety     — weight on avoiding tiles others likely need (read from what
//                they've melded + not discarded)
//   mistake    — probability of picking the 2nd-best discard instead of the best
//   claimAggro — how eagerly it pungs/kongs to speed its own hand
//   callWin    — always true; a bot never declines a legal win
// PaoMaJai races reward raw speed (no yaku gate), so the default profile leans
// efficiency-heavy. 'easy' bots make more mistakes and read safety poorly.
const BOT_PROFILES = {
  easy:   { efficiency: 0.6, safety: 0.1, mistake: 0.35, claimAggro: 0.45 },
  normal: { efficiency: 1.0, safety: 0.4, mistake: 0.15, claimAggro: 0.65 },
  hard:   { efficiency: 1.0, safety: 0.9, mistake: 0.03, claimAggro: 0.80 },
}
function botProfile(l, s) {
  return BOT_PROFILES[(s && s.botLevel) || l.botLevel || 'normal'] || BOT_PROFILES.normal
}

// faan → payout units, capped at the limit hand.
function faanToUnits(style, faan) {
  const f = Math.min(faan, style.limitFaan)
  const tbl = style.faanUnits
  if (tbl[f] != null) return tbl[f]
  // Above the top explicit entry → limit-hand units.
  const keys = Object.keys(tbl).map(Number).sort((a, b) => a - b)
  return tbl[keys[keys.length - 1]]
}

// ─── Lobby / seat state ─────────────────────────────────────────────────────
// One lobby object per open game. Seats are fixed indices 0..3 in wind order
// East(0) South(1) West(2) North(3); the DEALER is whichever seat holds the
// East wind this hand (rotates). Seat.hand holds concealed tile ints; melds are
// exposed; bonuses are set-aside flowers/seasons.
let lobbySeq = 1
const lobbies = {}   // id -> lobby

function makeSeat(index) {
  return {
    index,
    identifier: null, name: null, isBot: false, rank: 0,
    stack: 0,                  // engine chip stack (buy-in tracked by relay)
    buyIn: 0,
    hand: [],                  // concealed tile ints
    melds: [],                 // [{ type, tiles:int[], concealed:bool, from?:seat }]
    bonuses: [],               // flowers/seasons set aside
    discards: [],              // this player's discard pile (public)
    ready: false,
    connected: true,
    lastResult: null,          // per-hand outcome
  }
}

function makeLobby(opts) {
  const style = STYLES[opts.style]
  const id = 'mj_' + (lobbySeq++)
  const l = {
    id,
    name: opts.name,
    style: style.id,
    baseBet: opts.baseBet,
    buyIn: opts.baseBet * BUYIN_UNITS,
    password: opts.password || null,     // 4-digit string or null
    hostId: opts.hostId,
    hostName: opts.hostName,
    noRake: !!opts.noRake,               // Gold+ host → rake-free table (relay sets this)
    fillBots: opts.fillBots !== false,   // default: fill empty seats with bots
    botLevel: BOT_PROFILES[opts.botLevel] ? opts.botLevel : 'normal',  // easy|normal|hard bot skill
    createdAt: Date.now(),
    seats: [makeSeat(0), makeSeat(1), makeSeat(2), makeSeat(3)],
    watchers: {},                        // identifier -> true

    state: 'waiting',   // waiting | dealing | playing | claiming | scoring | washout | payout
    roundWind: 0,        // 0=East… advances every full rotation (a 圈)
    dealerSeat: 0,       // seat index holding East this hand
    handNumber: 0,       // increments each dealt hand
    dealerRepeat: 0,     // consecutive dealer wins (連莊)

    // wall + fairness
    serverSeed: null, serverSeedHash: null, clientSeed: null, handNonce: 0,
    wall: [], wallPos: 0, deadWall: 14,   // HK leaves 14 tiles as the dead wall
    _revealedSeed: null,

    // turn/claim machinery
    turnSeat: 0,          // whose turn to draw+discard
    lastDiscard: null,    // { seat, tile } most recent discard awaiting claims
    claims: {},           // seat -> { type, meldTiles? } pending claim this window
    claimEnd: 0,          // epoch sec claim window closes
    claimResponded: {},   // seat -> true once it has claimed or passed this window
    turnDeadline: 0,      // epoch sec current turn auto-plays
    drawnThisTurn: false, // current player has drawn (must discard next)
    pendingKongDraw: false,
    robbingKongTile: null,// tile just added-konged, open to a robbing-kong win

    // pacing
    dealQueue: [], nextStepAt: 0, phaseEnd: 0,
    botActAt: {},         // seat -> epoch ms a bot should act

    // 跑馬仔 per-hand kong income (collected on each kong, independent of the win)
    kongLedger: {},       // seat index -> chip delta accrued from kongs this hand
    kongEvents: [],       // [{ seat, kind, from, units }] for the payout screen

    lastResult: null,     // settlement snapshot for the relay
    _paidHand: -1,        // persistent double-pay guard (claim endpoint)
  }
  return l
}

function seatOf(l, identifier) {
  return l.seats.find(s => s.identifier === identifier) || null
}
function occupiedSeats(l) { return l.seats.filter(s => s.identifier) }
function humanSeats(l) { return l.seats.filter(s => s.identifier && !s.isBot) }
function anyBots(l) { return l.seats.some(s => s.isBot) }
// seat index -> identifier for occupied HUMAN seats (bots omitted). The relay
// uses this to attribute per-hand chip swings to citizen IDs for stats/XP.
function seatIdMap(l) {
  const m = {}
  for (const s of humanSeats(l)) m[s.index] = s.identifier
  return m
}
function nextSeat(i) { return (i + 1) % SEATS }         // counterclockwise turn order
function leftOf(i) { return (i + SEATS - 1) % SEATS }   // upstream (feeds chow)
// Seat wind = distance from dealer (dealer=East). Turn order goes E→S→W→N.
function seatWindOf(l, seatIndex) {
  return WINDS[(seatIndex - l.dealerSeat + SEATS) % SEATS]
}
// ─── Wall + draws ────────────────────────────────────────────────────────
function freshWall(l) {
  l.serverSeed = crypto.randomBytes(32).toString('hex')
  l.serverSeedHash = sha256(l.serverSeed)
  l.clientSeed = crypto.randomBytes(8).toString('hex')
  l.handNonce++
  l.wall = buildWall(l.serverSeed, l.clientSeed, l.handNonce)
  l.wallPos = 0
  l._revealedSeed = null
}
// Live tiles left to draw (excludes the 14-tile dead wall).
function tilesLeft(l) { return Math.max(0, (WALL_SIZE - l.deadWall) - l.wallPos) }
function drawTile(l) {
  const t = l.wall[l.wallPos]; l.wallPos++; return t
}

// A player draws; any bonus tile (flower/season) is set aside and a replacement
// is drawn from the wall until a normal tile lands. Returns the kept tile, or
// null if the wall ran dry mid-replacement (washout handled by caller).
function drawKeeping(l, seat) {
  while (true) {
    if (tilesLeft(l) <= 0) return null
    const t = drawTile(l)
    if (isBonus(t)) { seat.bonuses.push(t); continue }   // 補花: set aside, redraw
    return t
  }
}

// ─── Hand start / dealing ──────────────────────────────────────────────────
// Deal 13 to each seat (dealer gets a 14th to open). Bonus tiles drawn during
// the deal are replaced immediately (HK 開花補花). Dealing is metered by the
// tick for a live feel, but the wall order is fixed the instant we build it.
function startHand(l) {
  const style = STYLES[l.style]
  freshWall(l)
  l.handNumber++
  l.state = 'dealing'
  l.lastDiscard = null
  l.claims = {}
  l.robbingKongTile = null
  l.pendingKongDraw = false
  l.drawnThisTurn = false
  l.kongLedger = {}          // reset per-hand kong income
  l.kongEvents = []
  for (const s of l.seats) {
    if (!s.identifier) continue
    s.hand = []; s.melds = []; s.bonuses = []; s.discards = []; s.lastResult = null
  }
  // Deal the opening hand: 13 to each occupied seat in draw order from the
  // dealer (bonus tiles replaced immediately), then one extra to the dealer.
  // Dealt instantly server-side — the NUI animates the reveal client-side, and
  // this keeps the 250ms tick from stretching the deal over many seconds.
  for (let k = 0; k < style.handTiles; k++) {
    for (let step = 0; step < SEATS; step++) {
      const seat = l.seats[(l.dealerSeat + step) % SEATS]
      if (!seat.identifier) continue
      const t = drawKeeping(l, seat)
      if (t == null) { washout(l); return }
      seat.hand.push(t)
    }
  }
  const dealer = l.seats[l.dealerSeat]
  const opener = drawKeeping(l, dealer)          // dealer's opening 14th tile
  if (opener == null) { washout(l); return }
  dealer.hand.push(opener); dealer._justDrew = opener
  for (const s of occupiedSeats(l)) s.hand.sort((a, b) => a - b)
  // Dealer is on-turn with 14 tiles and must discard (or may open with a win /
  // concealed kong — checked when they act).
  l.state = 'playing'
  l.turnSeat = l.dealerSeat
  l.drawnThisTurn = true                          // opening tile counts as their draw
  l.turnDeadline = Math.floor(Date.now() / 1000) + TURN_TIME
  l.phaseEnd = 0
  scheduleBot(l, l.dealerSeat)
}

// ─── Washout (荒莊) — wall exhausted with no winner ──────────────────────────
// Dealer keeps the button (連莊). No WIN money moves, but 跑馬仔 kong income was
// already collected during the hand and must still settle (money can move with
// no winner — 開槓收錢 is independent of 和牌).
function washout(l) {
  l.state = 'washout'
  l._revealedSeed = l.serverSeed
  const kongLedger = l.kongLedger || {}
  const deltas = {}
  for (const s of occupiedSeats(l)) deltas[s.index] = (kongLedger[s.index] || 0)
  for (const s of occupiedSeats(l)) s.stack += (deltas[s.index] || 0)
  l.lastResult = {
    lobby: l.id, handNumber: l.handNumber, kind: 'washout', scoring: STYLES[l.style].scoring,
    dealerSeat: l.dealerSeat, roundWind: WINDS[l.roundWind],
    kongEvents: l.kongEvents, kongDeltas: kongLedger,
    deltas,   // kong-only transfers (empty {} for hk_old / no kongs)
    seatIds: seatIdMap(l),
    serverSeedHash: l.serverSeedHash, clientSeed: l.clientSeed, handNonce: l.handNonce,
    revealedSeed: l._revealedSeed, settledAt: Date.now(),
  }
  l.phaseEnd = Math.floor(Date.now() / 1000) + HAND_HOLD
}
// ─── Turn flow ──────────────────────────────────────────────────────────
// Advance to the next seat: they draw a tile, then must discard (or declare a
// self-draw win / concealed kong). Skips empty seats.
function advanceTurn(l, toSeat) {
  let si = toSeat
  for (let guard = 0; guard < SEATS; guard++) {
    if (l.seats[si].identifier) break
    si = nextSeat(si)
  }
  l.turnSeat = si
  l.lastDiscard = null
  l.claims = {}
  const seat = l.seats[si]
  const t = drawKeeping(l, seat)
  if (t == null) { washout(l); return }
  seat.hand.push(t)
  seat.hand.sort((a, b) => a - b)
  seat._justDrew = t
  l.drawnThisTurn = true
  l.turnDeadline = Math.floor(Date.now() / 1000) + TURN_TIME
  l.state = 'playing'
  scheduleBot(l, si)
}

// Player discards a tile from their (14-tile) hand → opens a claim window.
function doDiscard(l, seat, tile) {
  const idx = seat.hand.indexOf(tile)
  if (idx < 0) return { error: 'not in hand' }
  if (!l.drawnThisTurn) return { error: 'must draw first' }
  seat.hand.splice(idx, 1)
  seat.hand.sort((a, b) => a - b)
  seat.discards.push(tile)
  seat._justDrew = null
  l.drawnThisTurn = false
  l.lastDiscard = { seat: seat.index, tile }
  l.robbingKongTile = null
  // Open the claim window. If nobody can possibly claim, we could skip, but the
  // tick resolves an empty window in one pass anyway.
  l.state = 'claiming'
  l.claims = {}
  l.claimResponded = {}
  l.claimEnd = Math.floor(Date.now() / 1000) + CLAIM_WINDOW
  // Seats that physically cannot claim this tile are auto-passed so the window
  // can close the instant every live opponent has responded (no dead wait).
  const style = STYLES[l.style]
  for (const s of l.seats) {
    if (!s.identifier || s.index === seat.index) continue
    const canWin = !!wouldWin(s.hand, s.melds, s.bonuses, tile, winCtx(l, s.index, false), style.goOutFaan)
    const canP = canPung(s.hand, tile)
    const canK = canKongFromDiscard(s.hand, tile)
    const canC = style.allowChow && (!style.chowFromLeftOnly || s.index === nextSeat(seat.index)) && chowOptions(s.hand, tile).length > 0
    if (!canWin && !canP && !canK && !canC) l.claimResponded[s.index] = true
  }
  // Let bots register claims (or pass) during the window.
  for (const s of l.seats) if (s.isBot && s.index !== seat.index && !l.claimResponded[s.index]) scheduleBotClaim(l, s.index)
  // If nobody can claim at all (everyone auto-passed), close the window now.
  maybeResolveClaims(l)
  return { ok: true }
}

// Register a claim on the current discard. Validated for legality; the tick
// resolves priority when the window closes (or immediately on a win claim).
function registerClaim(l, seatIndex, type, meldTiles) {
  if (l.state !== 'claiming' || !l.lastDiscard) return { error: 'no claim window' }
  if (seatIndex === l.lastDiscard.seat) return { error: 'cannot claim own discard' }
  const seat = l.seats[seatIndex]
  const tile = l.lastDiscard.tile
  const style = STYLES[l.style]
  if (type === 'win') {
    const ctx = winCtx(l, seatIndex, false)
    const w = wouldWin(seat.hand, seat.melds, seat.bonuses, tile, ctx, style.goOutFaan)
    if (!w) return { error: 'not a winning tile' }
    l.claims[seatIndex] = { type: 'win', faan: w.faan, detail: w.detail }
    l.claimResponded[seatIndex] = true
    // Resolve as soon as every live opponent has responded; resolveClaims applies
    // win > pung/kong > chow priority and head-bump among multiple winners.
    maybeResolveClaims(l)
    return { ok: true }
  }
  if (type === 'kong') {
    if (!canKongFromDiscard(seat.hand, tile)) return { error: 'cannot kong' }
    l.claims[seatIndex] = { type: 'kong' }
    l.claimResponded[seatIndex] = true
    maybeResolveClaims(l)
    return { ok: true }
  }
  if (type === 'pung') {
    if (!canPung(seat.hand, tile)) return { error: 'cannot pung' }
    l.claims[seatIndex] = { type: 'pung' }
    l.claimResponded[seatIndex] = true
    maybeResolveClaims(l)
    return { ok: true }
  }
  if (type === 'chow') {
    if (!style.allowChow) return { error: 'chow not allowed in this style' }
    if (style.chowFromLeftOnly && seatIndex !== nextSeat(l.lastDiscard.seat))
      return { error: 'chow only from upstream discard' }
    const opts = chowOptions(seat.hand, tile)
    if (!opts.length) return { error: 'cannot chow' }
    // Caller may pass which two tiles to use; default to first legal option.
    let use = opts[0]
    if (meldTiles && meldTiles.length === 2) {
      const match = opts.find(o => o[0] === meldTiles[0] && o[1] === meldTiles[1])
      if (match) use = match
    }
    l.claims[seatIndex] = { type: 'chow', meldTiles: use }
    l.claimResponded[seatIndex] = true
    maybeResolveClaims(l)
    return { ok: true }
  }
  return { error: 'unknown claim' }
}

// A seat passes on the current discard.
function passClaim(l, seatIndex) {
  if (l.state !== 'claiming') return { ok: true }
  delete l.claims[seatIndex]
  l.claimResponded[seatIndex] = true
  maybeResolveClaims(l)
  return { ok: true }
}

// Close the window early once every live opponent has responded (claimed/passed).
function maybeResolveClaims(l) {
  if (l.state !== 'claiming' || !l.lastDiscard) return
  for (const s of l.seats) {
    if (!s.identifier || s.index === l.lastDiscard.seat) continue
    if (!l.claimResponded[s.index]) return
  }
  resolveClaims(l)
}

// Resolve the claim window by priority: win > pung/kong > chow. Ties on win
// (multiple ron) — HK Old Style: the player closest downstream of the discarder
// wins (head-bump). Pung/kong beat chow regardless of seat order.
function resolveClaims(l) {
  const disc = l.lastDiscard
  if (!disc) return
  const entries = Object.entries(l.claims).map(([si, c]) => ({ seat: Number(si), ...c }))
  const wins = entries.filter(e => e.type === 'win')
  if (wins.length) {
    // Head-bump: order by downstream distance from the discarder.
    wins.sort((a, b) =>
      ((a.seat - disc.seat + SEATS) % SEATS) - ((b.seat - disc.seat + SEATS) % SEATS))
    return settleWin(l, wins[0].seat, disc.tile, false, wins[0].faan, wins[0].detail)
  }
  const pk = entries.find(e => e.type === 'pung' || e.type === 'kong')
  if (pk) return applyMeldClaim(l, pk)
  const chow = entries.find(e => e.type === 'chow')
  if (chow) return applyMeldClaim(l, chow)
  // No claims: turn passes to the seat downstream of the discarder; they draw.
  advanceTurn(l, nextSeat(disc.seat))
}

// Apply a pung/kong/chow claim: remove the used concealed tiles, form the
// exposed meld off the discard, and hand the turn to the claimer (who must now
// discard — a kong first draws a replacement tile).
function applyMeldClaim(l, claim) {
  const disc = l.lastDiscard
  const seat = l.seats[claim.seat]
  const tile = disc.tile
  // Pull the discard out of the discarder's pile (it becomes part of the meld).
  const dp = l.seats[disc.seat].discards
  if (dp[dp.length - 1] === tile) dp.pop()
  if (claim.type === 'chow') {
    for (const c of claim.meldTiles) seat.hand.splice(seat.hand.indexOf(c), 1)
    seat.melds.push({ type: 'chow', tiles: [claim.meldTiles[0], claim.meldTiles[1], tile].sort((a, b) => a - b), concealed: false, from: disc.seat })
  } else if (claim.type === 'pung') {
    removeN(seat.hand, tile, 2)
    seat.melds.push({ type: 'pung', tiles: [tile, tile, tile], concealed: false, from: disc.seat })
  } else if (claim.type === 'kong') {
    removeN(seat.hand, tile, 3)
    seat.melds.push({ type: 'kong', tiles: [tile, tile, tile, tile], concealed: false, from: disc.seat })
    recordKong(l, seat.index, 'bigMing', disc.seat)   // 大明槓: discarder pays (跑馬仔)
  }
  seat.hand.sort((a, b) => a - b)
  l.turnSeat = claim.seat
  l.lastDiscard = null
  l.claims = {}
  if (claim.type === 'kong') {
    // Kong draws a replacement from the wall (補槓); then must discard.
    const t = drawKeeping(l, seat)
    if (t == null) { washout(l); return }
    seat.hand.push(t); seat.hand.sort((a, b) => a - b); seat._justDrew = t
    l.pendingKongDraw = false
  }
  l.drawnThisTurn = true   // claimer already holds the tile; next action is discard
  l.state = 'playing'
  l.turnDeadline = Math.floor(Date.now() / 1000) + TURN_TIME
  scheduleBot(l, claim.seat)
}

function removeN(arr, val, n) {
  for (let k = 0; k < n; k++) { const i = arr.indexOf(val); if (i >= 0) arr.splice(i, 1) }
}
// ─── On-turn actions (draw already happened at turn start) ──────────────────
// Build the faan-scoring context for a win by `seatIndex`.
function winCtx(l, seatIndex, selfPick, extra) {
  return Object.assign({
    selfPick,
    winByLastCatch: tilesLeft(l) <= 0,   // 海底 / last tile
    seatWind: seatWindOf(l, seatIndex),
    roundWind: WINDS[l.roundWind],
  }, extra || {})
}

// Self-draw win (自摸): the on-turn player declares with their 14-tile hand.
function actSelfWin(l, seat) {
  if (l.turnSeat !== seat.index || !l.drawnThisTurn) return { error: 'not your turn' }
  const style = STYLES[l.style]
  const ctx = winCtx(l, seat.index, true, { winByKong: !!seat._afterKong })
  if (!isStructuralWin(seat.hand, seat.melds)) return { error: 'not a winning hand' }
  const { faan, detail } = scoreHand(seat.hand, seat.melds, seat.bonuses, ctx)
  if (faan < style.goOutFaan) return { error: `need ${style.goOutFaan} faan (have ${faan})` }
  settleWin(l, seat.index, null, true, faan, detail)
  return { ok: true }
}

// Concealed kong (暗槓) or added kong (加槓 — upgrade own pung) on your turn.
// Added kong opens a robbing-kong window (搶槓) before the replacement draw.
function actKong(l, seat, tile) {
  if (l.turnSeat !== seat.index || !l.drawnThisTurn) return { error: 'not your turn' }
  const c = counts(seat.hand)
  const ownPung = seat.melds.find(m => m.type === 'pung' && m.tiles[0] === tile)
  if (c[tile] === 4) {
    // Concealed kong: four in hand.
    removeN(seat.hand, tile, 4)
    seat.melds.push({ type: 'kong', tiles: [tile, tile, tile, tile], concealed: true })
    recordKong(l, seat.index, 'concealed')       // 暗槓 income (跑馬仔)
  } else if (ownPung && c[tile] === 1) {
    // Added kong: upgrade the melded pung. Robbing-kong check first.
    const robber = findRobbingKong(l, seat.index, tile)
    if (robber != null) {
      seat.hand.splice(seat.hand.indexOf(tile), 1)   // tile leaves hand into the (robbed) kong
      const rSeat = l.seats[robber]
      const ctx = winCtx(l, robber, false, { robbingKong: true })
      const w = wouldWin(rSeat.hand, rSeat.melds, rSeat.bonuses, tile, ctx, STYLES[l.style].goOutFaan)
      return settleWin(l, robber, tile, false, w.faan, w.detail, { robbedFrom: seat.index, robbingKong: true })
    }
    ownPung.type = 'kong'; ownPung.tiles = [tile, tile, tile, tile]
    seat.hand.splice(seat.hand.indexOf(tile), 1)
    recordKong(l, seat.index, 'added')           // 加槓 income (跑馬仔; only if not robbed)
  } else {
    return { error: 'cannot kong that tile' }
  }
  seat.hand.sort((a, b) => a - b)
  // Replacement draw from the wall, then the player continues (must discard/win).
  const t = drawKeeping(l, seat)
  if (t == null) { washout(l); return { ok: true } }
  seat.hand.push(t); seat.hand.sort((a, b) => a - b); seat._justDrew = t
  seat._afterKong = true
  l.turnDeadline = Math.floor(Date.now() / 1000) + TURN_TIME
  scheduleBot(l, seat.index)
  return { ok: true }
}

// Is there a downstream player who can rob this added-kong tile to win?
function findRobbingKong(l, kongSeat, tile) {
  const style = STYLES[l.style]
  for (let step = 1; step < SEATS; step++) {
    const si = (kongSeat + step) % SEATS
    const s = l.seats[si]
    if (!s.identifier) continue
    const ctx = winCtx(l, si, false, { robbingKong: true })
    if (wouldWin(s.hand, s.melds, s.bonuses, tile, ctx, style.goOutFaan)) return si
  }
  return null
}

// ─── 跑馬仔 horse chart + kong income ────────────────────────────────────────
// Horse (獎馬) tile sets by the winner's SEAT POSITION relative to the dealer
// (跑馬仔 has no round/seat winds, so "position" = distance from 莊/East).
//   1st 莊/East:  numbers 1,5,9 (all 3 suits) + own wind East
//   2nd South:    numbers 2,6           + own wind South
//   3rd West:     numbers 3,7           + own wind West
//   4th North:    numbers 4,8           + own wind North
// Dragons (中 red / 發 green / 白 white) differ by chart:
//   mode2 (default, balanced 10-kinds-each): S/W/N each share ALL of 中發白;
//     dealer gets none. Every seat ends with exactly 10 kinds.
//   mode1 (一龍一位): S=中, W=發, N=白; dealer none. Uneven (dealer 10, rest 8).
const HORSE_NUMBERS = { east: [1, 5, 9], south: [2, 6], west: [3, 7], north: [4, 8] }
const HORSE_WIND    = { east: 27, south: 28, west: 29, north: 30 }   // own wind honor code
// mode1: one dragon per non-dealer seat (中=31 發=32 白=33)
const HORSE_DRAGON_MODE1 = { east: [], south: [31], west: [32], north: [33] }
const HORSE_DRAGON_MODE2 = { east: [], south: [31, 32, 33], west: [31, 32, 33], north: [31, 32, 33] }

// Does tile `code` count as a horse for a winner sitting at position `posWind`?
function isHorse(code, posWind, chart) {
  if (isBonus(code)) return false                     // flowers/seasons never match
  if (isSuited(code)) return HORSE_NUMBERS[posWind].includes(numOf(code))
  if (code === HORSE_WIND[posWind]) return true        // own seat wind
  const dragons = chart === 'mode1' ? HORSE_DRAGON_MODE1 : HORSE_DRAGON_MODE2
  return dragons[posWind].includes(code)
}

// Flip `count` horse tiles for a self-draw winner. Reads the next live wall
// tiles AFTER the current draw position (順著摸下一隻牌) without consuming them —
// the hand is ending, and keeping them as wall[wallPos…] makes the result
// reconstructible from the seed. If the live wall runs short, each missing tile
// auto-counts as a hit (中馬論). Returns the reveal + hit count.
function flipHorses(l, winnerSeat, count) {
  const chart = STYLES[l.style].horses.chart
  const posWind = seatWindOf(l, winnerSeat)
  const liveEnd = WALL_SIZE - l.deadWall
  const flipped = []
  let hits = 0, cursor = l.wallPos
  for (let i = 0; i < count; i++) {
    if (cursor < liveEnd) {
      const t = l.wall[cursor++]
      const hit = isHorse(t, posWind, chart)
      flipped.push({ tile: tileLabel(t), hit })
      if (hit) hits++
    } else {
      flipped.push({ tile: null, hit: true, auto: true })  // 中馬論
      hits++
    }
  }
  return { posWind, chart, count, hits, flipped }
}

// Record kong income into the per-hand ledger (跑馬仔 only). Collected the
// instant the kong is made, independent of who eventually wins.
//   kind 'concealed' 暗槓  → every other player pays kong.concealed
//   kind 'bigMing'   大明槓 → the discarder (fromSeat) pays kong.bigMing alone
//   kind 'added'     加槓  → every other player pays kong.added
function recordKong(l, seatIndex, kind, fromSeat) {
  const style = STYLES[l.style]
  if (style.scoring !== 'paomajai') return
  const rate = (style.kong && style.kong[kind]) || 0
  if (!rate) return
  const amt = rate * l.baseBet
  const led = l.kongLedger
  if (kind === 'bigMing') {
    if (fromSeat != null && fromSeat !== seatIndex && l.seats[fromSeat] && l.seats[fromSeat].identifier) {
      led[seatIndex] = (led[seatIndex] || 0) + amt
      led[fromSeat]  = (led[fromSeat]  || 0) - amt
    }
  } else {
    let gained = 0
    for (const s of occupiedSeats(l)) {
      if (s.index === seatIndex) continue
      led[s.index] = (led[s.index] || 0) - amt
      gained += amt
    }
    led[seatIndex] = (led[seatIndex] || 0) + gained
  }
  l.kongEvents.push({ seat: seatIndex, kind, from: kind === 'bigMing' ? fromSeat : null, units: rate })
}

// ─── Settlement ────────────────────────────────────────────────────────────
// HK payout model:
//   self-draw (自摸): every other player pays winner faanUnits × baseBet.
//   discard win (出銃): the discarder ("gun") pays the full faanUnits × baseBet
//     (包 — HK Old Style holds the feeder responsible for the whole hand).
//   dealer bonus: dealer winning or losing carries no extra multiplier here
//     (kept simple for Phase 1; 連莊 tracked for seating, not for money).
// Rake: 1% skimmed from the winner's gross on full-human tables (bots present →
// house is already the counterparty, so no rake). deltas are applied by relay.
function settleWin(l, winnerSeat, winTile, selfPick, faan, detail, extra) {
  const style = STYLES[l.style]
  const paomajai = style.scoring === 'paomajai'
  const winner = l.seats[winnerSeat]
  const players = occupiedSeats(l).length
  const deltas = {}       // seat -> chip delta from the WIN only (kong ledger merged later)
  for (const s of occupiedSeats(l)) deltas[s.index] = 0
  const losers = []
  const gun = (extra && extra.robbedFrom != null)
    ? extra.robbedFrom
    : (l.lastDiscard ? l.lastDiscard.seat : null)

  // per-mode "units" the win is worth (for the payout screen + lastResult)
  let units, perLoser, horseResult = null

  if (paomajai) {
    // 跑馬仔: flat units, no faan. Horses (獎馬) only on a clean self-draw.
    const perEach = style.units.selfDrawEach * l.baseBet   // 自摸 each-pays
    const ronAmt  = style.units.ron * l.baseBet            // 榮和 discarder-pays
    if (selfPick) {
      // 自摸: everyone pays perEach. Then flip horses; each hit = one more round.
      const winnerKongs = winner.melds.filter(m => m.type === 'kong').length
      const horseCount = style.horses.base + style.horses.perKong * winnerKongs
      horseResult = flipHorses(l, winnerSeat, horseCount)
      const perPlayer = perEach * (1 + horseResult.hits)   // base + one per 中馬
      for (const s of occupiedSeats(l)) {
        if (s.index === winnerSeat) continue
        deltas[s.index] = -perPlayer; losers.push(s.index)
      }
      units = style.units.selfDrawEach * (1 + horseResult.hits)
      perLoser = perPlayer
    } else if (extra && extra.robbingKong) {
      // 搶槓: the robbed kong-er 包自摸 — pays the self-draw amount for everyone.
      // Robber gets NO horse.
      if (gun != null && deltas[gun] != null) {
        deltas[gun] = -(perEach * (players - 1)); losers.push(gun)
      }
      units = style.units.selfDrawEach * (players - 1)
      perLoser = perEach
    } else {
      // 榮和: the discarder alone pays the ron amount (no 包 across the table).
      if (gun != null && deltas[gun] != null) {
        deltas[gun] = -ronAmt; losers.push(gun)
      }
      units = style.units.ron
      perLoser = ronAmt
    }
  } else {
    // hk_old faan ladder.
    units = faanToUnits(style, faan)
    perLoser = units * l.baseBet
    if (selfPick) {
      for (const s of occupiedSeats(l)) {
        if (s.index === winnerSeat) continue
        deltas[s.index] = -perLoser; losers.push(s.index)
      }
    } else if (gun != null && deltas[gun] != null) {
      deltas[gun] = -(perLoser * (players - 1)); losers.push(gun)   // 包
    } else {
      for (const s of occupiedSeats(l)) {
        if (s.index !== winnerSeat) { deltas[s.index] = -perLoser; losers.push(s.index) }
      }
    }
  }

  const gross = -Object.values(deltas).reduce((a, v) => a + Math.min(0, v), 0)  // total paid to winner
  // Rake only when the table is all-human AND the host is not a free-hosting
  // Gold+ member. Bots mean the house already funds the counterparty seats.
  // Rake is taken on the WIN gross only, never on kong transfers.
  const rakeEligible = !anyBots(l) && !l.noRake
  const rake = rakeEligible ? Math.floor(gross * RAKE_PCT) : 0
  deltas[winnerSeat] = gross - rake

  // Merge 跑馬仔 kong income (a winner can end net-negative — 和牌者仍要輸).
  const kongLedger = l.kongLedger || {}
  const finalDeltas = {}
  for (const s of occupiedSeats(l)) finalDeltas[s.index] = (deltas[s.index] || 0) + (kongLedger[s.index] || 0)

  // Apply to engine stacks so the live view + cash-out reflect it.
  for (const s of occupiedSeats(l)) s.stack += (finalDeltas[s.index] || 0)

  const dealerWon = winnerSeat === l.dealerSeat
  winner.lastResult = { won: true, faan, units, detail, net: finalDeltas[winnerSeat] }
  for (const li of losers) if (l.seats[li]) l.seats[li].lastResult = { won: false, paid: perLoser, net: finalDeltas[li] }

  l._revealedSeed = l.serverSeed
  l.lastResult = {
    lobby: l.id, handNumber: l.handNumber, kind: 'win', scoring: style.scoring,
    winnerSeat, winnerId: winner.identifier, winnerName: winner.name,
    selfPick, winTile: winTile != null ? tileLabel(winTile) : null,
    faan: paomajai ? null : faan, units, faanDetail: paomajai ? null : detail, baseBet: l.baseBet,
    perLoser, gross, rake, rakeEligible,
    robbingKong: !!(extra && extra.robbingKong),
    horses: horseResult,                       // 跑馬仔 self-draw horse reveal (null otherwise)
    kongEvents: l.kongEvents,                  // list of kongs made this hand
    kongDeltas: kongLedger,                    // seat -> kong-only chip delta
    winDeltas: deltas,                         // seat -> win-only chip delta (rake netted)
    deltas: finalDeltas,                       // seat -> TOTAL chip delta (win + kong) the relay applies
    seatIds: seatIdMap(l),
    dealerSeat: l.dealerSeat, roundWind: WINDS[l.roundWind], dealerWon,
    hands: revealHands(l),
    serverSeedHash: l.serverSeedHash, clientSeed: l.clientSeed, handNonce: l.handNonce,
    revealedSeed: l._revealedSeed, settledAt: Date.now(),
  }
  l.state = 'payout'
  l.phaseEnd = Math.floor(Date.now() / 1000) + HAND_HOLD
  return { ok: true }
}

// Full hand reveal (all concealed tiles) for the scoring screen.
function revealHands(l) {
  const out = {}
  for (const s of occupiedSeats(l)) {
    out[s.index] = {
      name: s.name, isBot: s.isBot, wind: seatWindOf(l, s.index),
      hand: s.hand.map(tileLabel),
      melds: s.melds.map(m => ({ type: m.type, tiles: m.tiles.map(tileLabel), concealed: !!m.concealed })),
      bonuses: s.bonuses.map(tileLabel),
    }
  }
  return out
}
// ─── Hand transition ───────────────────────────────────────────────────────
// After the payout/washout hold: rotate the dealer button (unless dealer won or
// it washed out → repeat), advance the round wind after a full lap, then either
// deal the next hand or drop back to waiting if too few players remain.
function nextHand(l) {
  const lr = l.lastResult
  const style = STYLES[l.style]
  if (style.winnerDeals) {
    // 跑馬仔: winner deals next (食糊者做莊); no round/seat winds. On a washout the
    // dealer keeps the button. (Multi-ron 富貴莊 doesn't arise — the claim
    // resolver head-bumps to a single winner.)
    if (lr && lr.kind === 'win') {
      if (lr.winnerSeat === l.dealerSeat) l.dealerRepeat++
      else { l.dealerRepeat = 0; l.dealerSeat = lr.winnerSeat }
    }
    // washout → dealer unchanged (dealerRepeat left as-is)
  } else {
    const dealerKeeps = lr && (lr.kind === 'washout' || (lr.kind === 'win' && lr.dealerWon))
    if (dealerKeeps) {
      l.dealerRepeat++
    } else {
      l.dealerRepeat = 0
      const prevDealer = l.dealerSeat
      l.dealerSeat = nextSeat(l.dealerSeat)
      // Skip empty seats for the button.
      let guard = 0
      while (!l.seats[l.dealerSeat].identifier && guard++ < SEATS) l.dealerSeat = nextSeat(l.dealerSeat)
      // Completed a full lap back to East's origin → advance the round wind (圈).
      if (l.dealerSeat <= prevDealer) l.roundWind = (l.roundWind + 1) % SEATS
    }
  }
  // Refill bot seats / cash out broke players before dealing.
  reconcileSeats(l)
  if (occupiedSeats(l).length >= 2 && humanSeats(l).length >= 1) {
    startHand(l)
  } else {
    l.state = 'waiting'
    l.phaseEnd = 0
  }
}

// Ensure the table is playable: fill empty seats with bots (if enabled), and
// mark any human whose stack fell below one base bet for cash-out.
function reconcileSeats(l) {
  if (l.fillBots) {
    for (const s of l.seats) {
      if (!s.identifier) seatBot(l, s.index)
    }
  }
}

function seatBot(l, index) {
  const names = ['Ah Fai', 'Siu Ming', 'Uncle Wong', 'Mrs Chan', 'Ah Keung', 'Fat Lung', 'Ah Sze', 'Ming Jai']
  const s = l.seats[index]
  s.identifier = 'bot:' + l.id + ':' + index
  s.name = names[index % names.length]
  s.isBot = true
  s.rank = 0
  s.stack = l.baseBet * BUYIN_UNITS   // house-funded
  s.buyIn = s.stack
  s.connected = true
}

// Convert a seated HUMAN into a bot IN PLACE, mid-hand — the bot inherits the
// player's exact game state (hand, melds, bonuses, discards, chip stack) and
// finishes the hand from where the human left off. Only identity/AI flags flip;
// no tiles are touched. If it's currently this seat's turn or an open claim
// window, the bot is scheduled to act so play doesn't stall.
function convertSeatToBot(l, index) {
  const names = ['Ah Fai', 'Siu Ming', 'Uncle Wong', 'Mrs Chan', 'Ah Keung', 'Fat Lung', 'Ah Sze', 'Ming Jai']
  const s = l.seats[index]
  s.identifier = 'bot:' + l.id + ':' + index
  s.name = names[index % names.length]
  s.isBot = true
  s.rank = 0
  s.connected = true
  // hand / melds / bonuses / discards / stack / buyIn are DELIBERATELY kept as-is
  // so the tiles the player was holding stay in play under the bot.
  if (l.state === 'playing' && l.turnSeat === index) {
    scheduleBot(l, index)
  } else if (l.state === 'claiming' && l.claimResponded && !l.claimResponded[index]) {
    scheduleBotClaim(l, index)
  }
}

// ─── AI bots (basic strategy) ───────────────────────────────────────────────
// A bot: always takes a self-draw win; claims a winning discard; otherwise
// discards the "most useless" tile (isolated honors/terminals first, keeping
// pairs and sequence-adjacent suited tiles). Claims pung on pairs it holds and
// chow only when it noticeably improves shape. Deliberately not a strong AI —
// it fills seats and keeps the table moving.
function scheduleBot(l, seatIndex) {
  const s = l.seats[seatIndex]
  if (s && s.isBot) l.botActAt[seatIndex] = Date.now() + botThinkMs('turn')
}
function scheduleBotClaim(l, seatIndex) {
  const s = l.seats[seatIndex]
  if (s && s.isBot) l.botActAt['claim:' + seatIndex] = Date.now() + botThinkMs('claim')
}

// Bot's on-turn decision (draw already done at turn start).
function botTakeTurn(l, s) {
  const style = STYLES[l.style]
  // Self-draw win — never declined.
  if (isStructuralWin(s.hand, s.melds)) {
    const ctx = winCtx(l, s.index, true, { winByKong: !!s._afterKong })
    const { faan } = scoreHand(s.hand, s.melds, s.bonuses, ctx)
    if (faan >= style.goOutFaan) { actSelfWin(l, s); return }
  }
  // Concealed kong — only if it doesn't set the hand back. In PaoMaJai a kong
  // also books immediate income + more horse flips, so it's near-always right;
  // in hk_old, keep it only when the quad wasn't part of a run we're building.
  const quads = concealedKongs(s.hand)
  if (quads.length && tilesLeft(l) > 2) {
    const q = quads[0]
    const before = handShanten(s.hand, s.melds)
    // Simulate the kong: 4 copies leave the concealed hand as one exposed meld.
    const after = s.hand.filter(t => t !== q)
    const afterSh = handShanten(after, (s.melds || []).concat([{ type: 'kong', tiles: [q, q, q, q] }]))
    const pmjWorth = style.scoring === 'paomajai'   // income + horses make it worth it
    if (pmjWorth || afterSh <= before) { actKong(l, s, q); return }
  }
  // Otherwise discard by efficiency/safety scoring.
  const tile = botChooseDiscard(l, s)
  doDiscard(l, s, tile)
}

// Bot's claim decision during a discard window. Claims are scored on whether
// the resulting hand actually advances (shanten drop) rather than fired at a
// flat probability — a bot no longer pungs a tile that stalls its hand.
function botConsiderClaim(l, s) {
  if (l.state !== 'claiming' || !l.lastDiscard) return
  if (l.claimResponded[s.index]) return
  const style = STYLES[l.style]
  const tile = l.lastDiscard.tile
  const ctx = winCtx(l, s.index, false)
  const prof = botProfile(l, s)
  // Win claim always.
  if (wouldWin(s.hand, s.melds, s.bonuses, tile, ctx, style.goOutFaan)) {
    registerClaim(l, s.index, 'win'); return
  }
  const before = handShanten(s.hand, s.melds)
  // Pung: it exposes a triplet. Worth it when it doesn't stall shanten and the
  // bot is feeling aggressive enough (claimAggro). Late in the hand, pung more
  // freely to race the wall out.
  if (canPung(s.hand, tile)) {
    const after = removeCopies(s.hand, tile, 2)
    const afterSh = handShanten(after, (s.melds || []).concat([{ type: 'pung', tiles: [tile, tile, tile] }]))
    const advances = afterSh < before || (afterSh === before && before <= 1)
    const lateWall = tilesLeft(l) < 20
    if (advances && Math.random() < (lateWall ? Math.min(1, prof.claimAggro + 0.2) : prof.claimAggro)) {
      registerClaim(l, s.index, 'pung'); return
    }
  }
  // Chow only from the upstream seat, and only if it drops shanten (skipped when
  // the style forbids chow, e.g. PaoMaJai 可碰不可吃).
  if (style.allowChow && s.index === nextSeat(l.lastDiscard.seat)) {
    const opts = chowOptions(s.hand, tile)
    for (const opt of opts) {
      const after = removeCopies(s.hand, opt[0], 1)
      const after2 = removeCopies(after, opt[1], 1)
      const afterSh = handShanten(after2, (s.melds || []).concat([{ type: 'chow', tiles: [opt[0], opt[1], tile] }]))
      if (afterSh < before && Math.random() < prof.claimAggro * 0.7) {
        registerClaim(l, s.index, 'chow', opt); return
      }
    }
  }
  // Nothing worth claiming → pass so the window can close early.
  passClaim(l, s.index)
}

// Remove up to n copies of a tile from a hand, returning a new array.
function removeCopies(hand, tile, n) {
  const out = []
  let removed = 0
  for (const t of hand) {
    if (t === tile && removed < n) { removed++; continue }
    out.push(t)
  }
  return out
}

// Efficiency + safety discard. For each distinct tile the bot could throw, it
// scores the resulting 13-tile hand by ukeire (how many tiles then advance it)
// and subtracts a danger term for tiles opponents likely want. The profile
// weights the two; `mistake` occasionally picks the 2nd-best so play isn't
// perfectly readable.
function botChooseDiscard(l, s) {
  const hand = s.hand
  const prof = botProfile(l, s)
  const seen = seenCounts(l, s)
  const distinct = [...new Set(hand)]
  // First pass: cheap shanten + danger for every candidate. Shanten dominates
  // the score (×100) and ukeire.count only breaks ties, so we skip the costly
  // 34-kind ukeire scan for candidates that aren't at the best shanten — that
  // pass is what made a full bot hand ~4s. handShanten is a single recursion;
  // ukeire is 34 of them, so this cuts per-turn work ~4×.
  const scored = []
  let minSh = 99
  for (const t of distinct) {
    if (isBonus(t)) continue
    const rest = removeCopies(hand, t, 1)
    const sh = handShanten(rest, s.melds)
    if (sh < minSh) minSh = sh
    const danger = discardDanger(l, s, t, seen)
    scored.push({ t, rest, sh, danger, count: 0 })
  }
  if (!scored.length) return hand[0]
  // Second pass: full ukeire (remaining-tile count) only for the shanten
  // leaders — those are the only ones whose count can flip the pick.
  for (const c of scored) {
    if (c.sh === minSh) c.count = ukeire(c.rest, s.melds, seen).count
    // Efficiency: fewer shanten is better; wider ukeire breaks ties. Danger:
    // how likely an opponent needs this tile (public info only).
    const eff = -c.sh * 100 + c.count
    c.score = prof.efficiency * eff - prof.safety * c.danger
  }
  scored.sort((a, b) => b.score - a.score)
  // The best discard is the one we KEEP away from (highest resulting-hand
  // score). Occasionally slip to the 2nd choice per the mistake rate.
  const pick = (scored.length > 1 && Math.random() < prof.mistake) ? scored[1] : scored[0]
  return pick.t
}

// Rough danger score for discarding `tile`: higher = more likely to feed an
// opponent. Uses only public info (exposed melds + discards), never hole cards.
function discardDanger(l, s, tile, seen) {
  const remain = 4 - (seen[tile] || 0)          // unseen copies still live
  if (remain <= 0) return 0                       // genbutsu-ish: all copies visible
  let danger = 0
  const wallLeft = tilesLeft(l)
  const pressure = wallLeft < 30 ? 1.4 : 1.0      // late hands = readier opponents
  for (const o of l.seats) {
    if (!o.identifier || o.index === s.index) continue
    // If this exact tile has already passed through this opponent's discards,
    // they can't be waiting on it (simplified furiten) → not dangerous to them.
    if (o.discards.includes(tile)) continue
    // Opponents with more exposed melds are closer to a win → scarier.
    const openness = (o.melds ? o.melds.length : 0)
    let d = 4 + openness * 6
    // Honors and terminals are generally safer to throw; middle tiles feed runs.
    if (isSuited(tile)) {
      const n = numOf(tile)
      d += (n >= 3 && n <= 7) ? 5 : 1
    } else {
      d += 1
    }
    danger += d
  }
  return danger * remain * 0.25 * pressure
}
// ─── Tick loop ─────────────────────────────────────────────────────────────
// One 250ms driver advances every lobby. Empty/idle lobbies sit cheaply in
// 'waiting'. Bots act on their scheduled timestamps.
setInterval(() => {
  const now = Math.floor(Date.now() / 1000)
  const nowMs = Date.now()
  for (const l of Object.values(lobbies)) {
    // Bots: turn actions + claim registrations fire on their timers regardless
    // of phase (guarded inside the handlers).
    for (const key of Object.keys(l.botActAt)) {
      if (nowMs < l.botActAt[key]) continue
      delete l.botActAt[key]
      if (key.startsWith('claim:')) {
        const si = Number(key.slice(6))
        const s = l.seats[si]
        if (s && s.isBot) botConsiderClaim(l, s)
      } else {
        const si = Number(key)
        const s = l.seats[si]
        if (s && s.isBot && l.state === 'playing' && l.turnSeat === si) botTakeTurn(l, s)
      }
    }

    if (l.state === 'playing') {
      // AFK auto-play: discard the just-drawn tile (or a heuristic pick).
      if (now >= l.turnDeadline && l.turnSeat != null) {
        const s = l.seats[l.turnSeat]
        if (s && s.identifier) {
          if (s.isBot) botTakeTurn(l, s)
          else {
            const t = s._justDrew != null && s.hand.includes(s._justDrew) ? s._justDrew : botChooseDiscard(s.hand)
            doDiscard(l, s, t)
          }
        }
      }
    } else if (l.state === 'claiming') {
      if (now >= l.claimEnd) resolveClaims(l)
    } else if (l.state === 'payout' || l.state === 'washout') {
      if (now >= l.phaseEnd) nextHand(l)
    }
  }
}, 250)

// ─── Public view ────────────────────────────────────────────────────────────
// What the relay broadcasts to NUI. Hides other players' concealed tiles
// (only counts) until the scoring reveal. `forId` scopes the "me" hand + isMe.
function publicView(l, forId) {
  const now = Math.floor(Date.now() / 1000)
  const style = STYLES[l.style]
  const revealed = l.state === 'payout' || l.state === 'washout'
  const seats = l.seats.map(s => {
    if (!s.identifier) return { index: s.index, empty: true }
    const isMe = s.identifier === forId
    return {
      index: s.index,
      name: s.name, isBot: s.isBot, isMe,
      wind: seatWindOf(l, s.index),
      isDealer: s.index === l.dealerSeat,
      stack: s.stack,
      handCount: s.hand.length,
      hand: (isMe || revealed) ? s.hand.map(tileLabel) : undefined,
      melds: s.melds.map(m => ({ type: m.type, tiles: m.tiles.map(tileLabel), concealed: !!m.concealed })),
      bonuses: s.bonuses.map(tileLabel),
      discards: s.discards.map(tileLabel),
      connected: s.connected,
      lastResult: revealed ? s.lastResult : undefined,
      justDrew: (isMe && s._justDrew != null) ? tileLabel(s._justDrew) : undefined,
    }
  })
  // Available actions for the viewer, so the NUI can light up buttons.
  const me = forId ? seatOf(l, forId) : null
  let actions = null
  if (me) {
    const myTurn = l.state === 'playing' && l.turnSeat === me.index && l.drawnThisTurn
    const canClaim = l.state === 'claiming' && l.lastDiscard && l.lastDiscard.seat !== me.index
    actions = {
      myTurn,
      canDiscard: myTurn,
      canSelfWin: myTurn && isStructuralWin(me.hand, me.melds),
      concealedKongs: myTurn ? concealedKongs(me.hand).map(tileLabel) : [],
      addedKongs: myTurn ? me.melds.filter(m => m.type === 'pung' && counts(me.hand)[m.tiles[0]] === 1).map(m => tileLabel(m.tiles[0])) : [],
      claim: canClaim ? {
        tile: tileLabel(l.lastDiscard.tile),
        win: !!wouldWin(me.hand, me.melds, me.bonuses, l.lastDiscard.tile, winCtx(l, me.index, false), style.goOutFaan),
        pung: canPung(me.hand, l.lastDiscard.tile),
        kong: canKongFromDiscard(me.hand, l.lastDiscard.tile),
        chow: (style.allowChow && (!style.chowFromLeftOnly || me.index === nextSeat(l.lastDiscard.seat)))
          ? chowOptions(me.hand, l.lastDiscard.tile).map(o => o.map(tileLabel)) : [],
      } : null,
    }
  }
  return {
    id: l.id, name: l.name, style: l.style, styleName: style.name,
    state: l.state, baseBet: l.baseBet, buyIn: l.buyIn, hasPassword: !!l.password,
    hostId: l.hostId, hostName: l.hostName,
    hostSeat: (() => { const hs = seatOf(l, l.hostId); return hs ? hs.index : null })(),
    handNumber: l.handNumber, roundWind: WINDS[l.roundWind], dealerSeat: l.dealerSeat,
    dealerRepeat: l.dealerRepeat, goOutFaan: style.goOutFaan,
    scoring: style.scoring, allowChow: style.allowChow !== false,
    kongEvents: l.kongEvents || [],       // 跑馬仔 kongs made this hand (live)
    kongDeltas: l.kongLedger || {},       // 跑馬仔 running kong income per seat
    turnSeat: l.turnSeat, lastDiscard: l.lastDiscard ? { seat: l.lastDiscard.seat, tile: tileLabel(l.lastDiscard.tile) } : null,
    tilesLeft: tilesLeft(l),
    turnRemaining: l.state === 'playing' ? Math.max(0, l.turnDeadline - now) : 0,
    claimRemaining: l.state === 'claiming' ? Math.max(0, l.claimEnd - now) : 0,
    phaseRemaining: l.phaseEnd ? Math.max(0, l.phaseEnd - now) : 0,
    seats, actions,
    serverSeedHash: l.serverSeedHash, handNonce: l.handNonce,
    result: revealed ? l.lastResult : null,
  }
}

// Compact lobby summary for the browser list.
function lobbySummary(l) {
  const style = STYLES[l.style]
  return {
    id: l.id, name: l.name, style: l.style, styleName: style.name,
    baseBet: l.baseBet, buyIn: l.buyIn, hasPassword: !!l.password,
    hostName: l.hostName, state: l.state, noRake: !!l.noRake,
    players: humanSeats(l).length, bots: l.seats.filter(s => s.isBot).length,
    seatsTaken: occupiedSeats(l).length, seatsTotal: SEATS,
    handNumber: l.handNumber,
  }
}
// ─── HTTP routes ───────────────────────────────────────────────────────────
function getLobby(req, res) {
  const l = lobbies[req.body?.id || req.params?.id]
  if (!l) { res.status(404).json({ error: 'no such lobby' }); return null }
  return l
}

// Styles the picker offers (with an enabled flag for coming-soon variants).
router.get('/styles', (req, res) => {
  res.json({
    styles: Object.values(STYLES).map(s => ({
      id: s.id, name: s.name, enabled: !!s.enabled,
      scoring: s.scoring || null,
      goOutFaan: s.goOutFaan || null,
      allowChow: s.allowChow !== false,
      units: s.units || null,        // 跑馬仔 flat payouts
      kong: s.kong || null,          // 跑馬仔 kong income rates
      horses: s.horses || null,      // 跑馬仔 horse config
    })),
    baseBetMin: BASE_BET_MIN, baseBetMax: BASE_BET_MAX, buyInUnits: BUYIN_UNITS,
    maxLobbies: MAX_LOBBIES,
  })
})

// Live lobby list for the browser.
router.get('/lobbies', (req, res) => {
  res.json({ lobbies: Object.values(lobbies).map(lobbySummary), max: MAX_LOBBIES })
})

// Create a lobby. FiveM has verified the host + will escrow their buy-in on the
// follow-up /join (host auto-joins seat 0). Returns the new lobby id + view.
router.post('/create', (req, res) => {
  if (Object.keys(lobbies).length >= MAX_LOBBIES)
    return res.status(400).json({ error: 'lobby limit reached' })
  const { identifier, name, style, baseBet, password, fillBots, noRake, botLevel } = req.body
  const st = STYLES[style]
  if (!st || !st.enabled) return res.status(400).json({ error: 'style not available' })
  const bet = Math.floor(Number(baseBet))
  if (!(bet >= BASE_BET_MIN && bet <= BASE_BET_MAX))
    return res.status(400).json({ error: `base bet $${BASE_BET_MIN}–$${BASE_BET_MAX}` })
  let pw = null
  if (password != null && password !== '') {
    pw = String(password)
    if (!/^\d{4}$/.test(pw)) return res.status(400).json({ error: 'password must be 4 digits' })
  }
  const { rank } = req.body
  const lobbyName = (name && String(name).slice(0, 40)) || `${st.name} table`
  const l = makeLobby({ style, baseBet: bet, password: pw, hostId: identifier, hostName: name, fillBots, noRake: !!noRake, botLevel, name: lobbyName })
  // Seat the host in seat 0 (relay has already escrowed their buy-in). This
  // keeps create atomic so the relay never needs a create-then-join two-step.
  const hs = l.seats[0]
  hs.identifier = identifier; hs.name = name || 'Player'; hs.isBot = false
  hs.rank = Number(rank) || 0
  hs.stack = l.buyIn; hs.buyIn = l.buyIn; hs.connected = true
  hs.hand = []; hs.melds = []; hs.bonuses = []; hs.discards = []; hs.lastResult = null
  l.watchers[identifier] = true
  lobbies[l.id] = l
  res.json({ ok: true, id: l.id, seat: 0, buyIn: l.buyIn, escrow: l.buyIn, view: publicView(l, identifier) })
})

// Join a lobby + take a seat. FiveM has escrowed the buy-in. Password checked
// here. seat optional (auto-pick lowest empty). Returns escrow the relay took.
router.post('/join', (req, res) => {
  const l = getLobby(req, res); if (!l) return
  const { identifier, name, password, seat, rank } = req.body
  if (l.password && String(password || '') !== l.password)
    return res.status(403).json({ error: 'wrong password' })
  if (seatOf(l, identifier)) {
    // Rejoin / refresh (e.g. reconnect): just register + return view.
    l.watchers[identifier] = true
    return res.json({ ok: true, rejoined: true, view: publicView(l, identifier), buyIn: 0 })
  }
  // Pick a seat: requested if free, else lowest free (kick a bot if none free).
  let idx = (seat != null && !l.seats[seat].identifier) ? Number(seat) : l.seats.findIndex(s => !s.identifier)
  if (idx < 0) {
    const botSeat = l.seats.find(s => s.isBot)
    if (botSeat && l.state === 'waiting') idx = botSeat.index
    else return res.status(400).json({ error: 'table full' })
  }
  const s = l.seats[idx]
  s.identifier = identifier; s.name = name || 'Player'; s.isBot = false
  s.rank = Number(rank) || 0
  s.stack = l.buyIn; s.buyIn = l.buyIn; s.connected = true
  s.hand = []; s.melds = []; s.bonuses = []; s.discards = []; s.lastResult = null
  l.watchers[identifier] = true
  res.json({ ok: true, seat: idx, escrow: l.buyIn, view: publicView(l, identifier) })
})

// Leave / cash out. Returns the chip stack to pay back (relay credits it). If
// mid-hand, the seat becomes a bot so the hand can finish; the leaving player's
// stack is frozen at cash-out (they forfeit the in-progress hand's swing).
router.post('/leave', (req, res) => {
  const l = getLobby(req, res); if (!l) return
  const { identifier } = req.body
  const s = seatOf(l, identifier)
  delete l.watchers[identifier]
  if (!s) return res.json({ ok: true, cashOut: 0 })
  const cashOut = Math.max(0, s.stack)
  const wasHost = l.hostId === identifier
  if (l.state === 'waiting' || l.state === 'payout' || l.state === 'washout') {
    // Between hands: safe to fully vacate and reseat a fresh bot.
    Object.assign(s, makeSeat(s.index))
    if (l.fillBots) seatBot(l, s.index)
  } else {
    // Mid-hand: hand the seat to a bot IN PLACE. The bot inherits the leaving
    // player's tiles (hand/melds/bonuses/discards) and finishes the hand, so
    // the table isn't disrupted and no tiles vanish.
    convertSeatToBot(l, s.index)
  }
  // Host left → reassign host to another human, or close if none remain.
  if (wasHost) {
    const other = humanSeats(l)[0]
    if (other) { l.hostId = other.identifier; l.hostName = other.name }
  }
  if (humanSeats(l).length === 0) delete lobbies[l.id]   // no humans → close lobby
  res.json({ ok: true, cashOut })
})

// Host starts the game (deal the first hand). Needs ≥1 human; bots fill rest.
router.post('/start', (req, res) => {
  const l = getLobby(req, res); if (!l) return
  const { identifier } = req.body
  if (l.hostId !== identifier) return res.status(403).json({ error: 'only the host can start' })
  if (l.state !== 'waiting') return res.status(400).json({ error: 'already started' })
  reconcileSeats(l)
  if (occupiedSeats(l).length < 2) return res.status(400).json({ error: 'need at least 2 players' })
  startHand(l)
  res.json({ ok: true, view: publicView(l, identifier) })
})

// Player action: discard | win | kong (concealed/added) during your turn;
// claim (win/pung/kong/chow) during a claim window.
router.post('/action', (req, res) => {
  const l = getLobby(req, res); if (!l) return
  const { identifier, action } = req.body
  const s = seatOf(l, identifier)
  if (!s) return res.status(400).json({ error: 'not seated' })
  let result
  switch (action) {
    case 'discard': {
      const tile = tileFromLabel(req.body.tile)
      if (tile == null) return res.status(400).json({ error: 'bad tile' })
      if (l.turnSeat !== s.index) return res.status(400).json({ error: 'not your turn' })
      result = doDiscard(l, s, tile); break
    }
    case 'win': result = actSelfWin(l, s); break
    case 'kong': {
      const tile = tileFromLabel(req.body.tile)
      if (tile == null) return res.status(400).json({ error: 'bad tile' })
      result = actKong(l, s, tile); break
    }
    case 'claim': {
      const meldTiles = Array.isArray(req.body.meldTiles) ? req.body.meldTiles.map(tileFromLabel) : null
      result = registerClaim(l, s.index, req.body.claim, meldTiles); break
    }
    case 'pass': result = passClaim(l, s.index); break
    default: return res.status(400).json({ error: 'unknown action' })
  }
  if (result && result.error) return res.status(400).json(result)
  res.json({ ok: true, view: publicView(l, identifier) })
})

// State snapshot. ?id= scopes the viewer's private hand + available actions.
router.get('/state/:id', (req, res) => {
  const l = lobbies[req.params.id]
  if (!l) return res.status(404).json({ error: 'no such lobby' })
  res.json(publicView(l, req.query.id))
})

// Register/refresh a watcher (broadcast targeting on the relay side).
router.post('/watch', (req, res) => {
  const l = getLobby(req, res); if (!l) return
  if (req.body.identifier) l.watchers[req.body.identifier] = true
  res.json(publicView(l, req.body.identifier))
})

// Settlement claim: returns the last hand's deltas ONCE per handNumber (the
// persistent double-pay guard — mirrors blackjack's /settle/:room/claim). The
// relay applies deltas to real money exactly once even across resource restarts.
router.post('/settle/:id/claim', (req, res) => {
  const l = lobbies[req.params.id]
  if (!l) return res.status(404).json({ error: 'no such lobby' })
  const lr = l.lastResult
  if (!lr) return res.json({ result: null })
  if (l._paidHand === lr.handNumber) return res.json({ result: null, alreadyPaid: true })
  l._paidHand = lr.handNumber
  res.json({ result: lr })
})

// Read-only settlement peek (no claim) for late joiners / spectators.
router.get('/settle/:id', (req, res) => {
  const l = lobbies[req.params.id]
  if (!l) return res.status(404).json({ error: 'no such lobby' })
  res.json({ result: l.lastResult })
})

// Player disconnect: same as leave but always safe (relay guarantees escrow
// reconciliation). Returns cash-out for every lobby the player sat in.
router.post('/disconnect', (req, res) => {
  const { identifier } = req.body
  let cashOut = 0
  for (const l of Object.values(lobbies)) {
    delete l.watchers[identifier]
    const s = seatOf(l, identifier)
    if (!s) continue
    cashOut += Math.max(0, s.stack)
    const idx = s.index, wasHost = l.hostId === identifier
    if (l.state === 'waiting' || l.state === 'payout' || l.state === 'washout') {
      Object.assign(s, makeSeat(idx))
      if (l.fillBots) seatBot(l, idx)
    } else {
      // Mid-hand disconnect: bot inherits the hand and plays it out.
      convertSeatToBot(l, idx)
    }
    if (wasHost) { const o = humanSeats(l)[0]; if (o) { l.hostId = o.identifier; l.hostName = o.name } }
    if (humanSeats(l).length === 0) delete lobbies[l.id]
  }
  res.json({ ok: true, cashOut })
})

// ─── Label ⇄ int helper (routes speak labels; engine speaks ints) ───────────
function tileFromLabel(label) {
  if (typeof label === 'number') return label   // allow raw ints too
  if (typeof label !== 'string') return null
  const suitMatch = /^([1-9])([msp])$/.exec(label)
  if (suitMatch) {
    const n = Number(suitMatch[1]) - 1
    return suitMatch[2] === 'm' ? n : suitMatch[2] === 's' ? 9 + n : 18 + n
  }
  const wi = WIND_LABEL.indexOf(label); if (wi >= 0) return 27 + wi
  const di = DRAGON_LABEL.indexOf(label); if (di >= 0) return 31 + di
  const fm = /^F:(.+)$/.exec(label); if (fm) { const i = FLOWER_LABEL.indexOf(fm[1]); if (i >= 0) return 34 + i }
  const sm = /^S:(.+)$/.exec(label); if (sm) { const i = SEASON_LABEL.indexOf(sm[1]); if (i >= 0) return 38 + i }
  return null
}

// Expose pure helpers + internals for headless self-tests (mirrors casino.js).
// The router is the primary export; these ride along and are harmless in prod.
// True while this identifier is seated (human) in a lobby with a hand in progress
// (state past 'waiting'). Used by the in-game-priority roundcheck: opening the
// casino in-game WAITS while the player has a live mahjong hand on the phone.
// During 'waiting' they can leave and cash out their stack, so that is not "live".
function hasLiveRound(identifier) {
  for (const id of Object.keys(lobbies)) {
    const l = lobbies[id]
    if (!l || l.state === 'waiting') continue
    const seat = seatOf(l, identifier)
    if (seat && !seat.isBot) return true
  }
  return false
}

// Where is this identifier currently seated (any lobby, any state)? Used by the
// active-game check so re-opening the casino can offer "Resume table" even when
// the player closed the app without clicking Leave. Skips bot-held seats and
// closed lobbies. Reports the lobby id + seat + style + phase so the client can
// rejoin the exact table. Returns null if not seated anywhere.
function peekSeat(identifier) {
  for (const id of Object.keys(lobbies)) {
    const l = lobbies[id]
    if (!l) continue
    const seat = seatOf(l, identifier)
    if (seat && !seat.isBot) {
      return {
        lobby: l.id, seat: seat.index, style: l.style,
        state: l.state, name: l.name,
        stack: seat.stack, baseBet: l.baseBet,
      }
    }
  }
  return null
}

// ── Web read-only helpers ────────────────────────────────────────────────────
// The web app (mobileCasino) is session-authed and needs the same styles/lobbies
// payloads + a viewer-scoped state, WITHOUT the raw router's identifier-in-body
// trust model. These return plain data so mobileCasino can serve them under its
// own requireSession. No money, no mutation.
function webStyles() {
  return {
    styles: Object.values(STYLES).map(s => ({
      id: s.id, name: s.name, enabled: !!s.enabled,
      scoring: s.scoring || null, goOutFaan: s.goOutFaan || null,
      allowChow: s.allowChow !== false, units: s.units || null,
      kong: s.kong || null, horses: s.horses || null,
    })),
    baseBetMin: BASE_BET_MIN, baseBetMax: BASE_BET_MAX,
    buyInUnits: BUYIN_UNITS, maxLobbies: MAX_LOBBIES,
  }
}
function webLobbies() {
  return { lobbies: Object.values(lobbies).map(lobbySummary), max: MAX_LOBBIES }
}
// Scoped view — but only if `identifier` is actually seated at this lobby, so a web
// client can't watch a private/other table it isn't in. Returns null otherwise.
function webState(lobbyId, identifier) {
  const l = lobbies[lobbyId]
  if (!l) return null
  if (!seatOf(l, identifier)) return null
  return publicView(l, identifier)
}

module.exports = router
module.exports.hasLiveRound = hasLiveRound
module.exports.peekSeat = peekSeat
module.exports.webStyles = webStyles
module.exports.webLobbies = webLobbies
module.exports.webState = webState
module.exports.STYLES = STYLES
module.exports.isHorse = isHorse
module.exports.flipHorses = flipHorses
module.exports.recordKong = recordKong
module.exports.settleWin = settleWin
module.exports.makeLobby = makeLobby
module.exports.seatWindOf = seatWindOf
module.exports.tileFromLabel = tileFromLabel
module.exports.tileLabel = tileLabel
module.exports._lobbies = lobbies
module.exports.handShanten = handShanten
module.exports.ukeire = ukeire
module.exports.stdShanten = stdShanten
module.exports.tileFromLabel = tileFromLabel
// Bot internals + state drivers (headless sim / tests only).
module.exports.botTakeTurn = botTakeTurn
module.exports.botConsiderClaim = botConsiderClaim
module.exports.resolveClaims = resolveClaims
module.exports.startHand = startHand
module.exports.seatBot = seatBot
module.exports.BOT_PROFILES = BOT_PROFILES

