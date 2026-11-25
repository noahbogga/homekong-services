const fetch = require('node-fetch')

const WEBHOOK_ACTIVITY = process.env.DISCORD_WEBHOOK_ACTIVITY || ''
const WEBHOOK_BETS = process.env.DISCORD_WEBHOOK_BETS || ''

const COLORS = {
  win: 0x22c55e,
  loss: 0xef4444,
  crash: 0x00c8ff,
  bigwin: 0xfbbf24,
  activity: 0x8b5cf6,
}

const GAME_EMOJI = {
  dice: '🎲',
  mines: '💣',
  chicken: '🐔',
  plinko: '📍',
  crash: '📈',
}

const queue = []
let processing = false

async function processQueue() {
  if (processing) return
  processing = true
  while (queue.length > 0) {
    const { url, payload } = queue.shift()
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      console.error('[discord] webhook error:', err.message)
    }
    await new Promise(r => setTimeout(r, 500))
  }
  processing = false
}

function send(url, payload) {
  if (!url) return
  queue.push({ url, payload })
  processQueue()
}

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString()
}

function logBet({ identifier, game, stake, multiplier, payout, won }) {
  if (!WEBHOOK_BETS) return
  const emoji = GAME_EMOJI[game] || '🎰'
  const color = won ? COLORS.win : COLORS.loss
  const result = won ? `Won ${fmt(payout)}` : `Lost ${fmt(stake)}`

  send(WEBHOOK_BETS, {
    embeds: [{
      color,
      author: { name: `${emoji} ${game.toUpperCase()}` },
      description: `**${identifier}** — ${fmt(stake)} @ ${multiplier}x\n${result}`,
      timestamp: new Date().toISOString(),
    }],
  })
}

function logBigWin({ identifier, game, stake, multiplier, payout }) {
  if (!WEBHOOK_ACTIVITY) return
  const emoji = GAME_EMOJI[game] || '🎰'

  send(WEBHOOK_ACTIVITY, {
    embeds: [{
      color: COLORS.bigwin,
      title: `🏆 BIG WIN — ${emoji} ${game.toUpperCase()}`,
      description: `**${identifier}**\nStake: ${fmt(stake)}\nMultiplier: **${multiplier}x**\nPayout: **${fmt(payout)}**`,
      timestamp: new Date().toISOString(),
    }],
  })
}

function logCrashRound({ crashPoint, totalBets, totalStake, totalPayout, winners, losers }) {
  if (!WEBHOOK_ACTIVITY) return

  const profit = totalStake - totalPayout
  const profitColor = profit >= 0 ? COLORS.win : COLORS.loss

  send(WEBHOOK_ACTIVITY, {
    embeds: [{
      color: COLORS.crash,
      title: `📈 Crash Round — ${crashPoint}x`,
      fields: [
        { name: 'Players', value: `${totalBets}`, inline: true },
        { name: 'Total Stake', value: fmt(totalStake), inline: true },
        { name: 'Total Payout', value: fmt(totalPayout), inline: true },
        { name: 'Winners', value: `${winners}`, inline: true },
        { name: 'Losers', value: `${losers}`, inline: true },
        { name: 'House P&L', value: fmt(profit), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  })
}

function logCashout({ identifier, game, stake, multiplier, payout }) {
  if (!WEBHOOK_ACTIVITY) return
  if (multiplier < 3) return
  const emoji = GAME_EMOJI[game] || '🎰'

  send(WEBHOOK_ACTIVITY, {
    embeds: [{
      color: COLORS.activity,
      title: `${emoji} ${game.toUpperCase()} Cashout — ${multiplier}x`,
      description: `**${identifier}** cashed out\nStake: ${fmt(stake)} → Payout: **${fmt(payout)}**`,
      timestamp: new Date().toISOString(),
    }],
  })
}

function logGameLoss({ identifier, game, stake }) {
  if (!WEBHOOK_ACTIVITY) return
  if (stake < 500000) return
  const emoji = GAME_EMOJI[game] || '🎰'

  send(WEBHOOK_ACTIVITY, {
    embeds: [{
      color: COLORS.loss,
      title: `${emoji} Big Loss — ${game.toUpperCase()}`,
      description: `**${identifier}** lost **${fmt(stake)}**`,
      timestamp: new Date().toISOString(),
    }],
  })
}

module.exports = { logBet, logBigWin, logCrashRound, logCashout, logGameLoss }
