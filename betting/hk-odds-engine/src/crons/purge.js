const cron = require('node-cron')
const { getPool } = require('../db')

function startPurgeCron() {
  // Run daily at 04:00
  cron.schedule('0 4 * * *', async () => {
    await purgeOldBets()
  })
  console.log('[cron:purge] Scheduled daily at 04:00 (30-day retention)')
}

async function purgeOldBets() {
  const pool = getPool()
  if (!pool) return

  try {
    const [result] = await pool.query(
      `DELETE FROM hk_sportsbets WHERE created_at < NOW() - INTERVAL 30 DAY AND status IN ('won', 'lost', 'void')`
    )
    if (result.affectedRows > 0) {
      console.log(`[cron:purge] Deleted ${result.affectedRows} settled bets older than 30 days`)
    }
  } catch (err) {
    console.error('[cron:purge] Error:', err.message)
  }
}

module.exports = { startPurgeCron }
