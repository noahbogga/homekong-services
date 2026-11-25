// ═══════════════════════════════════════════════════════════════════════════
// BLACKJACK — live multiplayer table engine (Phase 1: core game logic)
//
// All game logic lives here (same model as crash). The FiveM resource is the
// MONEY authority: it escrows cash on bet/double/split and pays on settle. This
// engine trusts that the caller escrowed; it only computes cards + payouts.
//
// Two rooms, each its own shoe + seats + state machine:
//   bj_main  Main Floor  $50–$50k     H17, BJ 6:5  (matches house edge ~2%)
//   bj_vip   High Limit  $25k–$250k   S17, BJ 3:2, DAS, resplit  (~0.5%)  gold+
//
// Provably fair: 6-deck shoe, Fisher-Yates driven by HMAC-SHA256(serverSeed,
// clientSeed:nonce:cursor). serverSeedHash is committed at shoe start; the seed
// is revealed when the shoe is retired (~75% penetration) so every card in the
// shoe can be reconstructed and verified.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express')
const crypto = require('crypto')
const discord = require('../discord')

const router = express.Router()

// ─── Web-settle bridge (mirror of crash) ─────────────────────────────────────
// In-game, the relay (casino.lua) polls /settle/:room/claim and pays EVERY player
// in the result. WEB seats are placed straight against the engine (mobileBlackjack)
// and the relay must NOT pay them (it never took their cash), so the relay gates
// with `if not p.web`. The engine settles web players itself: mobileBlackjack
// registers a handler here, and settle() hands it the web slice of each finished
// round exactly once. Money stays out of this file; the handler owns applyGameCash.
let onWebBjSettle = null
function setWebBjSettleHandler(fn) { onWebBjSettle = fn }

// --- Crypto (mirror of casino.js / crypto.lua) ---
function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex')
}
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}
function generateGameHash(serverSeed, clientSeed, nonce, cursor = 0) {
  return hmacSha256(serverSeed, `${clientSeed}:${nonce}:${cursor}`)
}
// Deterministic float in [0,1) from a base hash + cursor. Re-hashes past the
// 8-float boundary so an arbitrarily long stream stays verifiable.
function floatFromHash(hash, cursor) {
  const idx = cursor * 8
  let h = hash
  if (idx + 8 > h.length) {
    h = sha256(hash + ':' + String(cursor))
    return parseInt(h.substring(0, 8), 16) / 0x100000000
  }
  return parseInt(h.substring(idx, idx + 8), 16) / 0x100000000
}

// ─── Cards & shoe ──────────────────────────────────────────────────────────
// A card is an integer 0..51: rank = card % 13 (0=A,1=2,..,9=10,10=J,11=Q,12=K),
// suit = floor(card / 13) (0♠ 1♥ 2♦ 3♣). Compact + trivially serializable.
const DECKS = 6
const SHOE_SIZE = DECKS * 52                 // 312
const PENETRATION = 0.75                     // reshuffle once 75% dealt

function rankOf(card) { return card % 13 }
function suitOf(card) { return Math.floor(card / 13) }

// Blackjack value: A=11 (soft-adjusted later), face=10, else pip.
function cardValue(card) {
  const r = rankOf(card)
  if (r === 0) return 11
  if (r >= 9) return 10          // 10, J, Q, K
  return r + 1
}
function cardLabel(card) {
  const R = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
  const S = ['S', 'H', 'D', 'C']
  return R[rankOf(card)] + S[suitOf(card)]
}

// Build an ordered 312-card shoe, then Fisher-Yates shuffle it deterministically
// from the fair stream. Cursor advances once per swap so the whole permutation
// is reconstructible from (serverSeed, clientSeed, nonce).
function buildShoe(serverSeed, clientSeed, nonce) {
  const shoe = []
  for (let d = 0; d < DECKS; d++) {
    for (let c = 0; c < 52; c++) shoe.push(c)
  }
  const hash = generateGameHash(serverSeed, clientSeed, nonce)
  // Fisher-Yates from the high end; float per step drives the swap index.
  for (let i = shoe.length - 1; i > 0; i--) {
    const f = floatFromHash(hash, shoe.length - 1 - i)
    const j = Math.floor(f * (i + 1))
    const t = shoe[i]; shoe[i] = shoe[j]; shoe[j] = t
  }
  return shoe
}

// ─── Hand evaluation ───────────────────────────────────────────────────────
// Returns { total, soft } where soft means an ace is still counted as 11.
function handValue(cards) {
  let total = 0, aces = 0
  for (const c of cards) {
    const v = cardValue(c)
    total += v
    if (rankOf(c) === 0) aces++
  }
  // Demote aces from 11→1 while busting.
  while (total > 21 && aces > 0) { total -= 10; aces-- }
  return { total, soft: aces > 0 && total <= 21 }
}
function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards).total === 21
}
function isBust(cards) { return handValue(cards).total > 21 }

// Poker rank of exactly 3 cards, for the 21+3 side bet.
function poker3(cards) {
  if (cards.length !== 3) return null
  const ranks = cards.map(rankOf).sort((a, b) => a - b)
  const suits = cards.map(suitOf)
  const flush = suits[0] === suits[1] && suits[1] === suits[2]
  const trips = ranks[0] === ranks[1] && ranks[1] === ranks[2]
  // Straight: consecutive, plus the A-K-Q wrap and A-2-3.
  let straight = (ranks[0] + 1 === ranks[1] && ranks[1] + 1 === ranks[2])
  if (ranks[0] === 0 && ranks[1] === 11 && ranks[2] === 12) straight = true  // A Q K
  if (ranks[0] === 0 && ranks[1] === 1 && ranks[2] === 2) straight = true     // A 2 3
  if (trips && flush) return 'suited_trips'
  if (straight && flush) return 'straight_flush'
  if (trips) return 'trips'
  if (straight) return 'straight'
  if (flush) return 'flush'
  return null
}

// Hot 3: player's first two cards + dealer upcard (three cards total).
// 777 is the jackpot; then three-of-a-kind; then the raw total ladder 21/20/19.
// Returns the HOT3_PAY key, or null for no win.
function hot3(cards) {
  if (cards.length !== 3) return null
  const ranks = cards.map(rankOf)
  // 7 = rank index 6. Three 7s is the top hand.
  if (ranks.every(r => r === 6)) return '777'
  // Sum of card values (A=11, face=10) — the "hot" total.
  const total = cards.reduce((a, c) => a + cardValue(c), 0)
  const suited = cards.map(suitOf).every(s => s === suitOf(cards[0]))
  if (total === 21 && suited) return 'suited_21'
  if (total === 21) return '21'
  if (total === 20) return '20'
  if (total === 19) return '19'
  return null
}

// Pair type for Perfect Pairs (first two cards of the main hand).
function pairType(cards) {
  if (cards.length < 2) return null
  const [a, b] = cards
  if (rankOf(a) !== rankOf(b)) return null
  if (suitOf(a) === suitOf(b)) return 'perfect'          // same rank + suit
  // Colored pair = same color (♠♣ black, ♥♦ red).
  const red = s => s === 1 || s === 2
  if (red(suitOf(a)) === red(suitOf(b))) return 'colored'
  return 'mixed'
}

// ─── Room config ───────────────────────────────────────────────────────────
const ROOMS = {
  bj_main: {
    id: 'bj_main', name: 'Main Floor',
    minBet: 50, maxBet: 50000,
    hitSoft17: true, bjPayNum: 6, bjPayDen: 5,   // H17, 6:5
    das: true, resplitTo: 2,                     // double-after-split, split to 2 hands
    charlie: false,                              // 6-card Charlie OFF (tightens edge ~1.8%)
    surrender: false,                            // no late surrender on the main floor
    sideBets: true,                              // pairs / 21+3 / hot3 / bust It
    sideMax: 2500,                               // per-side-bet ceiling
    minRank: 0,                                  // open to all
  },
  bj_vip: {
    id: 'bj_vip', name: 'High Limit',
    minBet: 25000, maxBet: 2500000,
    hitSoft17: false, bjPayNum: 3, bjPayDen: 2,  // S17, 3:2
    das: true, resplitTo: 4,                     // resplit up to 4 hands
    charlie: false,                              // 6-card Charlie OFF
    surrender: true,                             // late surrender allowed (VIP perk)
    sideBets: true,                              // side bets open on High Limit
    sideMax: 50000,
    minRank: 4,                                  // gold+ (rank index in tier ladder)
  },
}
const SEATS = 8
const BET_WINDOW = 15          // seconds to place bets each round
const TURN_TIME = 20           // seconds per seat decision before auto-stand
const PAYOUT_HOLD = 6          // seconds the finished board stays visible

// ─── Pacing (ms) ─── Cards reveal one at a time, driven by the 250ms tick.
// Each value is how long that step lingers before the next reveal fires. This
// is what makes dealing feel human instead of a single synchronous burst.
const DEAL_STEP_MS = 380       // between each card during the opening deal
const HOLE_PAUSE_MS = 500      // beat after the hole card is tucked, before play
const DEALER_FLIP_MS = 700     // beat when the dealer flips the hole card
const DEALER_DRAW_MS = 900     // between each dealer draw
const INSURANCE_TIME = 12      // seconds of insurance decision when dealer shows Ace

// ─── Rules ───
const CHARLIE_CARDS = 6        // 6 cards totaling <=21 auto-wins (Six-Card Charlie)

// Side-bet paytables. Multiplier is the WIN multiple on the side stake (profit),
// i.e. payout returned to player = stake * (mult + 1). Insurance handled separately.
const PAIRS_PAY = { perfect: 25, colored: 12, mixed: 6 }
const P3_PAY = { suited_trips: 100, straight_flush: 40, trips: 30, straight: 10, flush: 5 }
// Bust It: dealer busts on N cards. Higher card count = rarer = bigger pay.
// Tuned to ~6.5% house edge off 3M-hand freq (3c=17.3%, 4c=8.9%, 5c=2.06%, 6c=0.27%, 7c=0.024%, 8c=0.001%).
const BUST_PAY = { 3: 1, 4: 2, 5: 8, 6: 40, 7: 100, 8: 250 }
// Hot 3 (Evolution): your 2 cards + dealer upcard. 777 tops it, then a suited
// 21, then the raw total ladder (21 > 20 > 19).
// Tuned to ~7.2% house edge off 3M-hand freq (777=0.042%, suited21=0.40%, 21=6.18%, 20=6.32%, 19=5.91%).
const HOT3_PAY = { '777': 100, 'suited_21': 20, '21': 5, '20': 3, '19': 2 }

// ─── Table state ───────────────────────────────────────────────────────────
// One live table object per room. Persisted only in memory (like crashState);
// the FiveM side re-syncs on restart. `bets` on a seat is escrowed cash the
// engine trusts was already taken by FiveM.
function freshShoe(t) {
  t.serverSeed = crypto.randomBytes(32).toString('hex')
  t.serverSeedHash = sha256(t.serverSeed)
  t.clientSeed = crypto.randomBytes(8).toString('hex')
  t.shoeNonce++
  t.shoe = buildShoe(t.serverSeed, t.clientSeed, t.shoeNonce)
  t.pos = 0
}
function makeTable(room) {
  const t = {
    room: room.id,
    state: 'waiting',          // waiting | dealing | insurance | playing | dealer | payout
    seats: {},                 // seatIndex -> seat object (see makeSeat)
    behind: {},                // identifier -> { seat, stake, name } bet-behind wagers
    watchers: {},              // identifier -> true (for broadcast targeting)
    dealer: { cards: [], hole: null },
    currentSeat: null,         // seat index whose turn it is (playing state)
    currentHand: 0,            // which split hand within that seat
    turnDeadline: 0,           // epoch seconds
    phaseEnd: 0,               // epoch seconds for waiting/insurance/payout auto-advance
    roundId: 0,
    shoeNonce: 0,
    lastResult: null,          // settlement snapshot from the last payout
    // ─── Pacing ─── the opening deal + dealer draws are metered out one card
    // at a time by the tick loop. dealQueue is a list of pending reveal steps;
    // nextStepAt is the epoch-ms the next queued step fires.
    dealQueue: [],             // [{ kind:'seat'|'dealerUp'|'hole', seat, ... }]
    nextStepAt: 0,             // Date.now() ms gate for the next paced reveal
    _beginPlayAt: 0,           // Date.now() ms to start turns after the deal beat
    reshuffled: false,         // true for the round right after a fresh shoe
    kicked: [],                // identifiers freed at window close (drained into the view)
  }
  freshShoe(t)
  return t
}
function makeSeat(identifier, name) {
  return {
    identifier, name: name || 'Player',
    bet: 0,                    // main stake (escrowed)
    sides: {},                 // { pairs, p3, bust } stakes (escrowed)
    hands: [],                 // array of { cards, bet, done, doubled, bust, blackjack, surrendered, split }
    insurance: 0,              // insurance stake (escrowed)
    joinedRound: 0,
    result: null,              // per-hand outcome filled at settle
  }
}

const tables = {
  bj_main: makeTable(ROOMS.bj_main),
  bj_vip: makeTable(ROOMS.bj_vip),
}

// Draw next card from the shoe; auto-reshuffle handled between rounds, not mid-deal.
function draw(t) {
  const card = t.shoe[t.pos]
  t.pos++
  return card
}

// ─── Round lifecycle ───────────────────────────────────────────────────────
function occupiedSeats(t) {
  return Object.keys(t.seats).map(Number).sort((a, b) => a - b)
    .filter(i => t.seats[i] && t.seats[i].bet > 0)
}

// Free any reserved seat with no bet down. Called when the betting window
// closes. Records the freed identifiers in t.kicked so the FiveM relay can tell
// those clients they lost the seat (and refund nothing — bet is 0). Keeps the
// table moving: one player not anteing never stalls the rest.
function kickNonBettors(t) {
  for (const i of Object.keys(t.seats)) {
    const s = t.seats[i]
    if (!s) continue
    if ((s.bet || 0) <= 0) {
      if (s.identifier) t.kicked.push(s.identifier)
      delete t.seats[i]
    }
  }
}

// Begin a new betting window. Retires the shoe if past penetration.
function startWaiting(t) {
  t.reshuffled = false
  t.kicked = []                     // fresh window: clear last round's kick list
  if (t.pos > SHOE_SIZE * PENETRATION) {
    t._revealedSeed = t.serverSeed   // expose the just-finished shoe's seed for verify
    freshShoe(t)
    t.reshuffled = true              // flag the fresh shoe for the reshuffle animation
  }
  t.state = 'waiting'
  t.roundId++
  t.dealer = { cards: [], hole: null }
  t.currentSeat = null
  t.currentHand = 0
  t.dealQueue = []
  t.nextStepAt = 0
  // Clear per-round seat data but keep the seat reservation.
  for (const i of Object.keys(t.seats)) {
    const s = t.seats[i]
    s.bet = 0; s.sides = {}; s.hands = []; s.insurance = 0; s.result = null
  }
  t.behind = {}
  t.phaseEnd = Math.floor(Date.now() / 1000) + BET_WINDOW
}

// Enter the dealing phase and queue the opening deal one card at a time.
// The order mirrors a real table: each seat's first card left-to-right, dealer
// upcard, each seat's second card, dealer hole card. dealStep() pops these on
// a timer so cards land one by one instead of all at once.
function deal(t) {
  const seats = occupiedSeats(t)
  if (seats.length === 0) { startWaiting(t); return }   // nobody bet → new window
  t.state = 'dealing'
  for (const i of seats) {
    const s = t.seats[i]
    s.hands = [{ cards: [], bet: s.bet, done: false, doubled: false, bust: false, blackjack: false, split: false }]
  }
  t.dealQueue = []
  for (const i of seats) t.dealQueue.push({ kind: 'seat', seat: i })   // round 1
  t.dealQueue.push({ kind: 'dealerUp' })
  for (const i of seats) t.dealQueue.push({ kind: 'seat', seat: i })   // round 2
  t.dealQueue.push({ kind: 'hole' })
  t.nextStepAt = Date.now()   // first card lands immediately, rest are paced
}

// Pop and apply one queued deal step. Called by the tick once nextStepAt passes.
function dealStep(t) {
  const step = t.dealQueue.shift()
  if (!step) return
  if (step.kind === 'seat') {
    t.seats[step.seat].hands[0].cards.push(draw(t))
  } else if (step.kind === 'dealerUp') {
    t.dealer.cards.push(draw(t))
  } else if (step.kind === 'hole') {
    t.dealer.hole = draw(t)
  }
  if (t.dealQueue.length > 0) {
    t.nextStepAt = Date.now() + DEAL_STEP_MS
    return
  }
  // Deal complete. Flag naturals, then branch to insurance or play after a beat.
  for (const i of occupiedSeats(t)) {
    const s = t.seats[i]
    if (isBlackjack(s.hands[0].cards)) { s.hands[0].blackjack = true; s.hands[0].done = true }
  }
  t.nextStepAt = Date.now() + HOLE_PAUSE_MS
  if (rankOf(t.dealer.cards[0]) === 0) {
    t.state = 'insurance'
    t.phaseEnd = Math.floor(Date.now() / 1000) + INSURANCE_TIME
  } else {
    t._beginPlayAt = Date.now() + HOLE_PAUSE_MS   // brief pause, then first turn
  }
}

// Advance to the first seat/hand that still needs a decision.
function beginPlay(t) {
  t.state = 'playing'
  advanceTurn(t, true)
}

// Move to the next actionable hand. If none remain, go to dealer play.
// `first` starts the scan from the top instead of after the current position.
function advanceTurn(t, first) {
  const seats = occupiedSeats(t)
  let si = first ? 0 : seats.indexOf(t.currentSeat)
  let hi = first ? 0 : t.currentHand + 1
  for (; si < seats.length; si++, hi = 0) {
    const s = t.seats[seats[si]]
    for (; hi < s.hands.length; hi++) {
      const h = s.hands[hi]
      if (!h.done && !h.bust) {
        t.currentSeat = seats[si]
        t.currentHand = hi
        t.turnDeadline = Math.floor(Date.now() / 1000) + TURN_TIME
        return
      }
    }
  }
  // No more hands to play → dealer.
  playDealer(t)
}

// Enter the dealer phase: flip the hole card, then let the tick draw one card
// at a time via dealerStep(). If no hand can still win, we skip straight to
// settle after the flip (dealer doesn't draw into a dead board).
function playDealer(t) {
  t.state = 'dealer'
  t.currentSeat = null
  t.dealer.cards.push(t.dealer.hole)
  t.dealer.hole = null
  t.nextStepAt = Date.now() + DEALER_FLIP_MS   // beat on the flip before drawing
}

// True if the dealer should take another card under the room's rule.
// The dealer completes their hand whenever any bet still rides on the dealer's
// outcome — a live main hand, OR any Bust It side bet (which pays when the
// dealer busts regardless of what the players did). Only when nothing depends
// on the dealer do we skip the draw.
function dealerShouldHit(t) {
  const room = ROOMS[t.room]
  const liveMain = occupiedSeats(t).some(i =>
    t.seats[i].hands.some(h => !h.bust && !h.surrendered && !h.charlie && !h.blackjack))
  const liveBustBet = occupiedSeats(t).some(i => (t.seats[i].sides.bust || 0) > 0)
  if (!liveMain && !liveBustBet) return false
  const { total, soft } = handValue(t.dealer.cards)
  if (total > 21) return false
  if (total > 17) return false
  if (total === 17 && !(soft && room.hitSoft17)) return false
  return true
}

// Draw one dealer card if the rule says hit; otherwise settle. Tick-driven.
function dealerStep(t) {
  if (dealerShouldHit(t)) {
    t.dealer.cards.push(draw(t))
    t.nextStepAt = Date.now() + DEALER_DRAW_MS
  } else {
    settle(t)
  }
}

// ─── Settlement ────────────────────────────────────────────────────────────
// Resolve the four side bets for one wager set against a hand's first two cards
// and the dealer upcard, accumulating stake/payout into result `r`. Shared by
// seated players and bet-behind backers (identical rules, same cards).
function resolveSideBets(r, sides, first2, dealerUp, dealerBust, dealerCards) {
  if (sides.pairs > 0) {
    const pt = pairType(first2)
    const mult = pt ? PAIRS_PAY[pt] : 0
    const p = mult ? sides.pairs * (mult + 1) : 0
    r.staked += sides.pairs; r.payout += p
    r.sides.push({ type: 'pairs', stake: sides.pairs, payout: p, won: !!mult, detail: pt })
  }
  if (sides.p3 > 0) {
    const combo = poker3([first2[0], first2[1], dealerUp])
    const mult = combo ? P3_PAY[combo] : 0
    const p = mult ? sides.p3 * (mult + 1) : 0
    r.staked += sides.p3; r.payout += p
    r.sides.push({ type: 'p3', stake: sides.p3, payout: p, won: !!mult, detail: combo })
  }
  if (sides.bust > 0) {
    const mult = dealerBust ? (BUST_PAY[dealerCards] || BUST_PAY[8]) : 0
    const p = mult ? sides.bust * (mult + 1) : 0
    r.staked += sides.bust; r.payout += p
    r.sides.push({ type: 'bust', stake: sides.bust, payout: p, won: dealerBust, detail: dealerBust ? dealerCards : null })
  }
  // Hot 3: player's two cards + dealer upcard total to 19/20/21 (or 777).
  if (sides.hot3 > 0) {
    const combo = hot3([first2[0], first2[1], dealerUp])
    const mult = combo ? HOT3_PAY[combo] : 0
    const p = mult ? sides.hot3 * (mult + 1) : 0
    r.staked += sides.hot3; r.payout += p
    r.sides.push({ type: 'hot3', stake: sides.hot3, payout: p, won: !!mult, detail: combo })
  }
}

// Produces t.lastResult: a per-identifier breakdown of stake vs payout that
// FiveM reads once to pay winners and record losers. payout is the TOTAL cash
// returned (stake included for pushes/wins), so net = payout - totalStaked.
function settle(t) {
  const room = ROOMS[t.room]
  const dealer = handValue(t.dealer.cards)
  const dealerBJ = isBlackjack(t.dealer.cards)
  const dealerBust = dealer.total > 21
  const dealerCards = t.dealer.cards.length

  const results = {}   // identifier -> { name, staked, payout, hands:[], sides:[], detail }
  function acc(id, name) {
    if (!results[id]) results[id] = { identifier: id, name, staked: 0, payout: 0, hands: [], sides: [] }
    return results[id]
  }

  for (const i of occupiedSeats(t)) {
    const s = t.seats[i]
    const r = acc(s.identifier, s.name)
    if (s.web) r.web = true       // web seat → relay skips paying, engine settles it

    // Main hands (may be multiple after splits).
    for (const h of s.hands) {
      const hv = handValue(h.cards)
      r.staked += h.bet
      let payout = 0, outcome
      if (h.surrendered) {
        payout = Math.floor(h.bet / 2); outcome = 'surrender'
      } else if (h.bust) {
        payout = 0; outcome = 'bust'
      } else if (h.charlie && !dealerBJ) {
        // Six-Card Charlie: 6 cards <=21 auto-wins 1:1, beats any dealer total
        // except a dealer natural.
        payout = h.bet * 2; outcome = 'charlie'
      } else if (dealerBJ && h.charlie) {
        payout = 0; outcome = 'lose'
      } else if (h.blackjack && !dealerBJ) {
        // Natural pays room rate; a split 21 is NOT a natural (handled as regular 21).
        payout = h.bet + Math.floor(h.bet * room.bjPayNum / room.bjPayDen); outcome = 'blackjack'
      } else if (dealerBJ && !h.blackjack) {
        payout = 0; outcome = 'lose'
      } else if (dealerBJ && h.blackjack) {
        payout = h.bet; outcome = 'push'
      } else if (dealerBust) {
        payout = h.bet * 2; outcome = 'win'
      } else if (hv.total > dealer.total) {
        payout = h.bet * 2; outcome = 'win'
      } else if (hv.total < dealer.total) {
        payout = 0; outcome = 'lose'
      } else {
        payout = h.bet; outcome = 'push'
      }
      r.payout += payout
      r.hands.push({ cards: h.cards.map(cardLabel), total: hv.total, bet: h.bet, payout, outcome, doubled: h.doubled, split: h.split, charlie: !!h.charlie })
    }

    // Insurance: pays 2:1 if dealer has blackjack, else lost. Stake already escrowed.
    if (s.insurance > 0) {
      r.staked += s.insurance
      const ip = dealerBJ ? s.insurance * 3 : 0    // 2:1 profit + stake back
      r.payout += ip
      r.sides.push({ type: 'insurance', stake: s.insurance, payout: ip, won: dealerBJ })
    }

    // Side bets resolve off the ORIGINAL two cards (pairs) / two + dealer up (21+3).
    const first2 = s.hands[0] ? s.hands[0].cards.slice(0, 2) : []
    resolveSideBets(r, s.sides, first2, t.dealer.cards[0], dealerBust, dealerCards)

    s.result = { hands: r.hands.slice(-s.hands.length) }
  }

  // Bet-behind: rides the backed seat's FIRST hand outcome (win/lose/push/bj),
  // 1:1 (or room BJ rate on a natural). May carry its own side bets, which
  // resolve off the BACKED seat's first two cards + dealer up.
  for (const [id, b] of Object.entries(t.behind)) {
    const s = t.seats[b.seat]
    const r = acc(id, b.name)
    if (b.web) r.web = true       // web bet-behind → relay skips, engine settles
    r.staked += b.stake
    // The backed seat never got a hand this round — the seated player failed to
    // ante and was kicked, or left before the deal. The behind bet (and any side
    // bets it carried) never had a hand to ride, so VOID it: refund the whole
    // wager instead of scoring a phantom loss. resolveSideBets is skipped below,
    // so fold the side stakes back here.
    if (!s || !s.hands[0]) {
      const sideTotal = Object.values(b.sides || {}).reduce((a, v) => a + v, 0)
      const refund = b.stake + sideTotal
      r.staked += sideTotal
      r.payout += refund
      r.sides.push({ type: 'behind', seat: b.seat, stake: b.stake, payout: b.stake, won: false, push: false, void: true })
      continue
    }
    let payout = 0, outcome = 'lose'
    const h = s.hands[0]
    const hv = handValue(h.cards)
    if (h.blackjack && !dealerBJ) { payout = b.stake + Math.floor(b.stake * room.bjPayNum / room.bjPayDen); outcome = 'blackjack' }
    else if (h.bust) { payout = 0; outcome = 'lose' }
    // Six-Card Charlie on the backed hand wins 1:1, beats any dealer total except
    // a dealer natural — mirror the seated Charlie rule.
    else if (h.charlie && !dealerBJ) { payout = b.stake * 2; outcome = 'win' }
    else if (dealerBJ && !h.blackjack) { payout = 0; outcome = 'lose' }
    else if (dealerBJ && h.blackjack) { payout = b.stake; outcome = 'push' }
    else if (dealerBust || hv.total > dealer.total) { payout = b.stake * 2; outcome = 'win' }
    else if (hv.total < dealer.total) { payout = 0; outcome = 'lose' }
    else { payout = b.stake; outcome = 'push' }
    r.payout += payout
    r.sides.push({ type: 'behind', seat: b.seat, stake: b.stake, payout, won: payout > b.stake, push: outcome === 'push' })

    if (b.sides) {
      const first2 = s.hands[0].cards.slice(0, 2)
      resolveSideBets(r, b.sides, first2, t.dealer.cards[0], dealerBust, dealerCards)
    }
  }

  t.lastResult = {
    room: t.room, roundId: t.roundId,
    dealer: { cards: t.dealer.cards.map(cardLabel), total: dealer.total, blackjack: dealerBJ, bust: dealerBust },
    players: Object.values(results),
    serverSeedHash: t.serverSeedHash, clientSeed: t.clientSeed, shoeNonce: t.shoeNonce,
    settledAt: Date.now(),
  }
  t.state = 'payout'
  t.phaseEnd = Math.floor(Date.now() / 1000) + PAYOUT_HOLD

  // Settle WEB players ourselves (relay pays only its own, gated on !p.web). Fired
  // once per round here — the payout-phase claim guard on the relay side is separate.
  // We use lastResult.roundId + a per-table guard so a re-settle can never double-pay.
  if (onWebBjSettle && t._webSettledRound !== t.roundId) {
    const webPlayers = t.lastResult.players.filter(p => p.web)
    if (webPlayers.length > 0) {
      t._webSettledRound = t.roundId
      try {
        onWebBjSettle(t.room, {
          roundId: t.roundId, players: webPlayers,
          serverSeedHash: t.serverSeedHash, shoeNonce: t.shoeNonce,
          revealedSeed: t._revealedSeed || null,
        })
      } catch (e) { console.error('[bj web settle]', e.message) }
    }
  }
}

// ─── Player actions ────────────────────────────────────────────────────────
// All actions require it to be this seat's turn on this hand. Return
// { ok, error } — the caller (FiveM) has already handled any escrow.
function currentHandOf(t, seatIndex) {
  if (t.state !== 'playing' || t.currentSeat !== seatIndex) return null
  const s = t.seats[seatIndex]
  return s ? s.hands[t.currentHand] : null
}

function actHit(t, seatIndex) {
  const h = currentHandOf(t, seatIndex)
  if (!h) return { error: 'not your turn' }
  h.cards.push(draw(t))
  const hv = handValue(h.cards)
  if (hv.total > 21) { h.bust = true; h.done = true; advanceTurn(t) }
  // Six-Card Charlie: 6 cards totaling <=21 auto-wins, hand ends immediately.
  // Only when the room enables it (off by default now — tightens the edge).
  else if (ROOMS[t.room].charlie && h.cards.length >= CHARLIE_CARDS) { h.charlie = true; h.done = true; advanceTurn(t) }
  else if (hv.total === 21) { h.done = true; advanceTurn(t) }
  else { t.turnDeadline = Math.floor(Date.now() / 1000) + TURN_TIME }
  return { ok: true }
}

function actStand(t, seatIndex) {
  const h = currentHandOf(t, seatIndex)
  if (!h) return { error: 'not your turn' }
  h.done = true
  advanceTurn(t)
  return { ok: true }
}

// Double: exactly one card, doubles the stake, hand ends. FiveM must have
// escrowed the extra `bet` already; engine just records it.
function actDouble(t, seatIndex) {
  const h = currentHandOf(t, seatIndex)
  if (!h) return { error: 'not your turn' }
  if (h.cards.length !== 2) return { error: 'double only on first two' }
  if (h.split && !ROOMS[t.room].das) return { error: 'no double after split' }
  const extra = h.bet          // matching the original stake
  h.bet *= 2
  h.doubled = true
  h.cards.push(draw(t))
  if (handValue(h.cards).total > 21) h.bust = true
  h.done = true
  advanceTurn(t)
  return { ok: true, escrowDelta: extra }
}

// Split: two same-RANK cards → two hands, one card dealt to each. Extra stake
// escrowed by FiveM. Respects room resplit cap.
function actSplit(t, seatIndex) {
  const h = currentHandOf(t, seatIndex)
  if (!h) return { error: 'not your turn' }
  const s = t.seats[seatIndex]
  if (h.cards.length !== 2) return { error: 'split only on first two' }
  if (rankOf(h.cards[0]) !== rankOf(h.cards[1])) return { error: 'not a pair' }
  if (s.hands.length >= ROOMS[t.room].resplitTo) return { error: 'resplit limit' }
  const extra = h.bet          // the new hand carries a matching stake
  const moved = h.cards.pop()
  const newHand = { cards: [moved], bet: h.bet, done: false, doubled: false, bust: false, blackjack: false, split: true }
  h.split = true
  // Deal one fresh card to each hand.
  h.cards.push(draw(t))
  newHand.cards.push(draw(t))
  // Insert the new hand right after the current one so turn order stays natural.
  s.hands.splice(t.currentHand + 1, 0, newHand)
  // Split aces get one card only, then auto-stand both.
  if (rankOf(h.cards[0]) === 0) {
    h.done = true; newHand.done = true; advanceTurn(t)
  } else {
    if (handValue(h.cards).total === 21) { h.done = true; advanceTurn(t) }
    else t.turnDeadline = Math.floor(Date.now() / 1000) + TURN_TIME
  }
  return { ok: true, escrowDelta: extra }
}

function actSurrender(t, seatIndex) {
  const h = currentHandOf(t, seatIndex)
  if (!h) return { error: 'not your turn' }
  if (!ROOMS[t.room].surrender) return { error: 'surrender not offered here' }
  if (h.cards.length !== 2 || h.split) return { error: 'surrender only on first two' }
  h.surrendered = true
  h.done = true
  advanceTurn(t)
  return { ok: true }
}

// ─── Tick loop ─────────────────────────────────────────────────────────────
// One 250ms driver advances every table's phases. Empty tables sit cheaply in
// 'waiting' (phaseEnd keeps sliding forward as long as nobody bet).
setInterval(() => {
  const now = Math.floor(Date.now() / 1000)
  const nowMs = Date.now()
  for (const t of Object.values(tables)) {
    if (t.state === 'waiting') {
      if (now >= t.phaseEnd) {
        // Betting window closed: kick any seat that never placed a bet this
        // round (idle reservation, closed screen, "sat but didn't ante"). You
        // hold a seat by betting every round, not by squatting.
        kickNonBettors(t)
        if (occupiedSeats(t).length > 0) deal(t)
        else t.phaseEnd = now + BET_WINDOW      // idle: keep window open, no deal
      }
    } else if (t.state === 'dealing') {
      // Meter out the opening deal one card at a time.
      if (t.dealQueue.length > 0) {
        if (nowMs >= t.nextStepAt) dealStep(t)
      } else if (t._beginPlayAt && nowMs >= t._beginPlayAt) {
        // Post-deal pause elapsed with no dealer Ace → start player turns.
        t._beginPlayAt = 0
        beginPlay(t)
      }
    } else if (t.state === 'insurance') {
      if (now >= t.phaseEnd) beginPlay(t)
    } else if (t.state === 'playing') {
      // AFK auto-stand so the table never stalls on one player.
      if (now >= t.turnDeadline && t.currentSeat != null) {
        const h = currentHandOf(t, t.currentSeat)
        if (h) { h.done = true; advanceTurn(t) }
        else advanceTurn(t)
      }
    } else if (t.state === 'dealer') {
      // Paced dealer draws: flip beat already set nextStepAt in playDealer().
      if (nowMs >= t.nextStepAt) dealerStep(t)
    } else if (t.state === 'payout') {
      if (now >= t.phaseEnd) startWaiting(t)
    }
  }
}, 250)

// ─── Public view (what FiveM broadcasts to NUI) ────────────────────────────
// Hides the dealer hole card until the dealer phase. Cards are labels for the UI.
function publicView(t, forId) {
  const now = Math.floor(Date.now() / 1000)
  const room = ROOMS[t.room]
  const seats = {}
  for (const [i, s] of Object.entries(t.seats)) {
    seats[i] = {
      identifier: s.identifier === forId ? s.identifier : undefined,
      name: s.name,
      isMe: s.identifier === forId,
      bet: s.bet,
      sides: s.sides,
      insurance: s.insurance,
      hands: s.hands.map(h => ({
        cards: h.cards.map(cardLabel),
        total: handValue(h.cards).total,
        soft: handValue(h.cards).soft,
        bet: h.bet, done: h.done, bust: h.bust,
        blackjack: h.blackjack, doubled: h.doubled, split: h.split,
        surrendered: !!h.surrendered, charlie: !!h.charlie,
      })),
    }
  }
  const dealerCards = t.dealer.cards.map(cardLabel)
  // During play, only the up-card is known; show a facedown placeholder.
  const showHole = t.state === 'dealer' || t.state === 'payout'
  const dealer = {
    cards: dealerCards,
    hole: showHole ? null : (t.dealer.hole != null ? 'XX' : null),
    total: showHole ? handValue(t.dealer.cards).total : (t.dealer.cards[0] != null ? cardValue(t.dealer.cards[0]) : 0),
  }
  // Shoe state for the card-pool UI. remaining counts down to the cut card
  // (75% penetration); reshuffled flags the first round of a fresh shoe.
  const cutAt = Math.floor(SHOE_SIZE * PENETRATION)
  const shoe = {
    total: SHOE_SIZE,
    used: t.pos,
    remaining: Math.max(0, SHOE_SIZE - t.pos),
    untilShuffle: Math.max(0, cutAt - t.pos),
    penetration: Math.round((t.pos / SHOE_SIZE) * 100),
    reshuffled: !!t.reshuffled,
  }
  return {
    room: t.room, roomName: room.name, state: t.state, roundId: t.roundId,
    minBet: room.minBet, maxBet: room.maxBet, sideMax: room.sideMax,
    hitSoft17: room.hitSoft17, bjPay: `${room.bjPayNum}:${room.bjPayDen}`,
    das: room.das, resplitTo: room.resplitTo,
    charlieCards: room.charlie ? CHARLIE_CARDS : 0,
    surrender: !!room.surrender, sideBetsOpen: !!room.sideBets,
    seats, dealer, shoe,
    currentSeat: t.currentSeat, currentHand: t.currentHand,
    dealerDrawing: t.state === 'dealer',
    turnRemaining: t.state === 'playing' ? Math.max(0, t.turnDeadline - now) : 0,
    phaseRemaining: Math.max(0, t.phaseEnd - now),
    serverSeedHash: t.serverSeedHash, shoeNonce: t.shoeNonce,
    behindCount: Object.keys(t.behind).length,
    kicked: t.kicked.slice(),   // identifiers freed at last window close
  }
}

// ─── HTTP routes ───────────────────────────────────────────────────────────
function getTable(req, res) {
  const t = tables[req.body?.room || req.params?.room]
  if (!t) { res.status(404).json({ error: 'no such room' }); return null }
  return t
}

// Rooms list (limits + rules + LIVE occupancy) for the NUI room picker.
function roomsList() {
  return Object.values(ROOMS).map(r => {
    const t = tables[r.id]
    const taken = t ? occupiedSeats(t).length : 0
    return {
      id: r.id, name: r.name, minBet: r.minBet, maxBet: r.maxBet,
      sideMax: r.sideMax, minRank: r.minRank,
      rules: `${r.hitSoft17 ? 'H17' : 'S17'} · BJ ${r.bjPayNum}:${r.bjPayDen}`,
      sideBets: r.sideBets ? ['pairs', 'p3', 'hot3', 'bust'] : [],
      sideBetsOpen: !!r.sideBets,
      surrender: !!r.surrender,
      seatsTaken: taken, seatsTotal: SEATS,
    }
  })
}
router.get('/rooms', (req, res) => {
  res.json({ rooms: roomsList() })
})

// State snapshot for one room. ?id= scopes hole-hiding + isMe flags per viewer.
router.get('/state/:room', (req, res) => {
  const t = tables[req.params.room]
  if (!t) return res.status(404).json({ error: 'no such room' })
  res.json(publicView(t, req.query.id))
})

// Register/refresh a watcher (for broadcast targeting on the FiveM side).
router.post('/join', (req, res) => {
  const t = getTable(req, res); if (!t) return
  if (req.body.identifier) t.watchers[req.body.identifier] = true
  res.json(publicView(t, req.body.identifier))
})
router.post('/leave', (req, res) => {
  const t = getTable(req, res); if (!t) return
  const id = req.body.identifier
  delete t.watchers[id]
  // Free their seat if the round hasn't dealt yet, and report escrow to refund.
  // Mid-round we keep the seat so their bet rides to settle (no orphaned cash).
  let refund = 0
  if (t.state === 'waiting') {
    for (const i of Object.keys(t.seats)) {
      const s = t.seats[i]
      if (s.identifier === id) {
        refund += s.bet + Object.values(s.sides).reduce((a, b) => a + b, 0) + (s.insurance || 0)
        delete t.seats[i]
      }
    }
    if (t.behind[id]) {
      const b = t.behind[id]
      refund += b.stake + Object.values(b.sides || {}).reduce((a, v) => a + v, 0)
      delete t.behind[id]
    }
  }
  res.json({ ok: true, refund })
})

// ─── Core mutations (shared by HTTP routes + the web path) ───────────────────
// Each returns { error } on rejection or { ok, ...data, view }. The `web` flag
// tags the seat/behind so settle() routes payment to the engine (not the relay).
// Money is NOT touched here — the caller escrows (relay in-game, mobileBlackjack
// on web) exactly the returned `escrow`/`escrowDelta`.
function sitTable(t, body, web) {
  const room = ROOMS[t.room]
  if (t.state !== 'waiting') return { error: 'betting closed' }
  const { identifier, name, seat, stake } = body
  const seatIndex = Number(seat)
  if (!(seatIndex >= 0 && seatIndex < SEATS)) return { error: 'bad seat' }
  if (t.seats[seatIndex] && t.seats[seatIndex].identifier !== identifier)
    return { error: 'seat taken' }
  // One seat per player.
  for (const i of Object.keys(t.seats)) {
    if (Number(i) !== seatIndex && t.seats[i].identifier === identifier)
      return { error: 'already seated' }
  }
  const bet = Math.floor(Number(stake))
  if (!(bet >= room.minBet && bet <= room.maxBet))
    return { error: `bet must be $${room.minBet}–$${room.maxBet}` }

  const sides = {}
  for (const k of ['pairs', 'p3', 'bust', 'hot3']) {
    const v = Math.floor(Number(body[k]) || 0)
    if (v > 0) {
      if (v > room.sideMax) return { error: `side bet max $${room.sideMax}` }
      if (v > bet) return { error: 'side bet cannot exceed main bet' }
      sides[k] = v
    }
  }
  const s = t.seats[seatIndex] || makeSeat(identifier, name)
  s.identifier = identifier; s.name = name || s.name
  s.bet = bet; s.sides = sides; s.joinedRound = t.roundId
  s.web = !!web
  t.seats[seatIndex] = s
  t.watchers[identifier] = true
  // If they were just kicked this window and are re-sitting, cancel the pending
  // kick notice so the relay doesn't bounce them out of the seat they retook.
  t.kicked = t.kicked.filter(id => id !== identifier)
  const escrow = bet + Object.values(sides).reduce((a, b) => a + b, 0)
  return { ok: true, seat: seatIndex, escrow, view: publicView(t, identifier) }
}

function behindTable(t, body, web) {
  const room = ROOMS[t.room]
  if (t.state !== 'waiting') return { error: 'betting closed' }
  const { identifier, name, seat, stake } = body
  const seatIndex = Number(seat)
  const target = t.seats[seatIndex]
  if (!target || target.bet <= 0) return { error: 'no player on that seat' }
  if (target.identifier === identifier) return { error: 'cannot bet behind yourself' }
  const bet = Math.floor(Number(stake))
  const cap = Math.min(target.bet, room.maxBet)
  if (!(bet >= room.minBet && bet <= cap)) return { error: `bet $${room.minBet}–$${cap}` }

  // Bet-behind may also place its own side bets, which resolve off the BACKED
  // seat's first two cards + dealer up (same cards the seated player's sides use).
  const sides = {}
  for (const k of ['pairs', 'p3', 'bust', 'hot3']) {
    const v = Math.floor(Number(body[k]) || 0)
    if (v > 0) {
      if (v > room.sideMax) return { error: `side bet max $${room.sideMax}` }
      if (v > bet) return { error: 'side bet cannot exceed backed bet' }
      sides[k] = v
    }
  }
  t.behind[identifier] = { seat: seatIndex, stake: bet, name: name || 'Player', sides, web: !!web }
  t.watchers[identifier] = true
  const escrow = bet + Object.values(sides).reduce((a, b) => a + b, 0)
  return { ok: true, escrow, view: publicView(t, identifier) }
}

function insureTable(t, body) {
  if (t.state !== 'insurance') return { error: 'no insurance window' }
  const { identifier, stake } = body
  let seat = null
  for (const i of Object.keys(t.seats)) if (t.seats[i].identifier === identifier) seat = t.seats[i]
  if (!seat) return { error: 'not seated' }
  const max = Math.floor(seat.hands[0].bet / 2)
  const ins = Math.min(Math.floor(Number(stake)), max)
  if (ins <= 0) return { error: 'bad insurance' }
  seat.insurance = ins
  return { ok: true, escrow: ins, view: publicView(t, identifier) }
}

function actionTable(t, body) {
  const { identifier, action } = body
  let seatIndex = null
  for (const i of Object.keys(t.seats)) if (t.seats[i].identifier === identifier) seatIndex = Number(i)
  if (seatIndex == null) return { error: 'not seated' }
  if (t.state !== 'playing' || t.currentSeat !== seatIndex) return { error: 'not your turn' }
  let result
  switch (action) {
    case 'hit': result = actHit(t, seatIndex); break
    case 'stand': result = actStand(t, seatIndex); break
    case 'double': result = actDouble(t, seatIndex); break
    case 'split': result = actSplit(t, seatIndex); break
    case 'surrender': result = actSurrender(t, seatIndex); break
    default: return { error: 'unknown action' }
  }
  if (result.error) return result
  return { ok: true, escrowDelta: result.escrowDelta || 0, view: publicView(t, identifier) }
}

// Sit + place the main bet. Only during 'waiting'. FiveM has escrowed `stake`
// (+ any side stakes) before calling. Side stakes validated against sideMax.
router.post('/sit', (req, res) => {
  const t = getTable(req, res); if (!t) return
  const r = sitTable(t, req.body, false)
  if (r.error) return res.status(400).json(r)
  res.json(r)
})

// Bet-behind a seated player. 'waiting' only. FiveM escrowed `stake`.
router.post('/behind', (req, res) => {
  const t = getTable(req, res); if (!t) return
  const r = behindTable(t, req.body, false)
  if (r.error) return res.status(400).json(r)
  res.json(r)
})

// Insurance during the insurance window. FiveM escrowed up to half the main bet.
router.post('/insure', (req, res) => {
  const t = getTable(req, res); if (!t) return
  const r = insureTable(t, req.body)
  if (r.error) return res.status(400).json(r)
  res.json(r)
})

// Player action: hit | stand | double | split | surrender.
// double/split need FiveM to escrow the extra stake FIRST; it passes the seat's
// current hand bet back so FiveM knows how much to take. We validate turn here.
router.post('/action', (req, res) => {
  const t = getTable(req, res); if (!t) return
  const r = actionTable(t, req.body)
  if (r.error) return res.status(400).json(r)
  res.json(r)
})

// Settlement snapshot for the just-finished round. FiveM polls this once on the
// waiting/payout transition to pay winners + record losers.
router.get('/settle/:room', (req, res) => {
  const t = tables[req.params.room]
  if (!t) return res.status(404).json({ error: 'no such room' })
  res.json({ result: t.lastResult, revealedSeed: t._revealedSeed || null })
})

// Atomic payout claim. Returns lastResult ONLY the first time a given roundId is
// claimed; every later call for the same round returns { result: null }. This is
// the persistent double-pay guard: the resource's in-memory guard resets on every
// restart, but this lives in engine memory (the engine is not restarted with the
// resource), so a FiveM restart can never re-pay an already-settled round.
router.post('/settle/:room/claim', (req, res) => {
  const t = tables[req.params.room]
  if (!t) return res.status(404).json({ error: 'no such room' })
  const lr = t.lastResult
  if (!lr) return res.json({ result: null })
  if (t._paidRound === lr.roundId) return res.json({ result: null, alreadyPaid: true })
  t._paidRound = lr.roundId
  res.json({ result: lr, revealedSeed: t._revealedSeed || null })
})

// Player disconnect: free seat + behind wagers (waiting only; mid-round they
// ride to settle so their escrow isn't stranded).
router.post('/disconnect', (req, res) => {
  const id = req.body.identifier
  let refund = 0
  for (const t of Object.values(tables)) {
    delete t.watchers[id]
    if (t.state === 'waiting') {
      for (const i of Object.keys(t.seats)) {
        const s = t.seats[i]
        if (s.identifier === id) {
          refund += s.bet + Object.values(s.sides).reduce((a, b) => a + b, 0) + (s.insurance || 0)
          delete t.seats[i]
        }
      }
      if (t.behind[id]) {
      const b = t.behind[id]
      refund += b.stake + Object.values(b.sides || {}).reduce((a, v) => a + v, 0)
      delete t.behind[id]
    }
    }
  }
  res.json({ ok: true, refund })
})

// True while this identifier has money committed to a blackjack round that is
// past the betting window (dealing..payout) — i.e. they cannot simply leave and be
// refunded. Used by the in-game-priority roundcheck so opening in-game WAITS for a
// live hand to finish. During 'waiting' a seat/behind can still cancel out, so that
// does not count as a live round. Survives the phone app being closed (state is
// server-side here).
function hasLiveRound(identifier) {
  for (const room of Object.keys(tables)) {
    const t = tables[room]
    if (!t || t.state === 'waiting') continue
    // seated with a main bet down
    for (const i of Object.keys(t.seats)) {
      const s = t.seats[i]
      if (s && s.identifier === identifier && (s.bet || 0) > 0) return true
    }
    // bet-behind another seat
    if (t.behind && t.behind[identifier]) return true
  }
  return false
}

// ─── Web-facing API (mobileBlackjack drives shared tables through these) ─────
// These mirror the HTTP routes but return plain objects (no req/res) and tag the
// seat web=true so settle() pays via the engine, not the relay. The web caller
// escrows the returned `escrow`/`escrowDelta` via applyGameCash before/around it.
function getRoomsWeb() { return roomsList() }
function getTableByRoom(room) { return tables[room] || null }
function getViewFor(room, identifier) {
  const t = tables[room]
  if (!t) return null
  return publicView(t, identifier)
}
// The settle snapshot for the room's most recent finished round (for web banners).
function getLastResult(room) {
  const t = tables[room]
  if (!t) return null
  return { result: t.lastResult, revealedSeed: t._revealedSeed || null }
}
function addBjWatcher(room, identifier) {
  const t = tables[room]; if (!t) return null
  t.watchers[identifier] = true
  return publicView(t, identifier)
}
function removeBjWatcher(room, identifier) {
  const t = tables[room]; if (!t) return
  delete t.watchers[identifier]
}
// Sit a WEB player. Returns { error } or { ok, seat, escrow, view }.
function sitWeb(room, body) {
  const t = tables[room]; if (!t) return { error: 'no such room' }
  return sitTable(t, body, true)
}
function behindWeb(room, body) {
  const t = tables[room]; if (!t) return { error: 'no such room' }
  return behindTable(t, body, true)
}
function insureWeb(room, body) {
  const t = tables[room]; if (!t) return { error: 'no such room' }
  return insureTable(t, body)
}
function actionWeb(room, body) {
  const t = tables[room]; if (!t) return { error: 'no such room' }
  return actionTable(t, body)
}
// Cost of a pending double/split for a WEB seat, so the caller can escrow it
// BEFORE the engine draws (money-safety parity with the in-game relay). Returns
// the current hand's bet, or 0 if it isn't this seat's turn / no hand.
function actionCost(room, identifier) {
  const t = tables[room]; if (!t) return 0
  if (t.state !== 'playing') return 0
  let seatIndex = null
  for (const i of Object.keys(t.seats)) if (t.seats[i].identifier === identifier) seatIndex = Number(i)
  if (seatIndex == null || t.currentSeat !== seatIndex) return 0
  const h = t.seats[seatIndex].hands[t.currentHand]
  return h ? (h.bet || 0) : 0
}
// Leave/free a WEB seat during 'waiting'; returns refundable escrow (bet + sides +
// insurance). Mid-round the seat rides to settle so escrow isn't stranded.
function leaveWeb(room, identifier) {
  const t = tables[room]; if (!t) return { ok: true, refund: 0 }
  delete t.watchers[identifier]
  let refund = 0
  if (t.state === 'waiting') {
    for (const i of Object.keys(t.seats)) {
      const s = t.seats[i]
      if (s.identifier === identifier) {
        refund += s.bet + Object.values(s.sides).reduce((a, b) => a + b, 0) + (s.insurance || 0)
        delete t.seats[i]
      }
    }
    if (t.behind[identifier]) {
      const b = t.behind[identifier]
      refund += b.stake + Object.values(b.sides || {}).reduce((a, v) => a + v, 0)
      delete t.behind[identifier]
    }
  }
  return { ok: true, refund }
}
// Is this identifier a WEB seat/behind at any table right now, and what phase?
// Used to restore the web UI after a reload (mobileBlackjack /casino/active).
function peekWebSeat(identifier) {
  for (const room of Object.keys(tables)) {
    const t = tables[room]
    for (const i of Object.keys(t.seats)) {
      const s = t.seats[i]
      if (s && s.web && s.identifier === identifier) {
        return { room, seat: Number(i), behind: false, state: t.state }
      }
    }
    if (t.behind[identifier] && t.behind[identifier].web) {
      return { room, seat: t.behind[identifier].seat, behind: true, state: t.state }
    }
  }
  return null
}

// Surface-agnostic version of peekWebSeat: is this identifier seated (or betting
// behind) at ANY table right now, regardless of web/in-game origin? Used by the
// shared /active check so both surfaces can offer "Resume your table" after the
// player navigated away without leaving. Returns { room, seat, behind, state }.
function peekSeat(identifier) {
  for (const room of Object.keys(tables)) {
    const t = tables[room]
    for (const i of Object.keys(t.seats)) {
      const s = t.seats[i]
      if (s && s.identifier === identifier) {
        return { room, seat: Number(i), behind: false, state: t.state }
      }
    }
    if (t.behind[identifier]) {
      return { room, seat: t.behind[identifier].seat, behind: true, state: t.state }
    }
  }
  return null
}

module.exports = router
module.exports.hasLiveRound = hasLiveRound
module.exports.peekSeat = peekSeat
module.exports.setWebBjSettleHandler = setWebBjSettleHandler
module.exports.getRoomsWeb = getRoomsWeb
module.exports.getTableByRoom = getTableByRoom
module.exports.getViewFor = getViewFor
module.exports.getLastResult = getLastResult
module.exports.addBjWatcher = addBjWatcher
module.exports.removeBjWatcher = removeBjWatcher
module.exports.sitWeb = sitWeb
module.exports.behindWeb = behindWeb
module.exports.insureWeb = insureWeb
module.exports.actionWeb = actionWeb
module.exports.actionCost = actionCost
module.exports.leaveWeb = leaveWeb
module.exports.peekWebSeat = peekWebSeat
module.exports.SEATS = SEATS
module.exports.ROOMS = ROOMS
