// gamePersist.js — persist active mines/chicken games to DB for crash recovery
const { getPool } = require('./db')

let activeGames = {}
let dirty = false

async function loadGames() {
  const pool = getPool()
  if (!pool) return
  try {
    const [rows] = await pool.query('SELECT game_key, game_data FROM hk_active_games')
    for (const row of rows) {
      try {
        const data = JSON.parse(row.game_data)
        // Restore Set for mines revealed tiles
        if (data.game === 'mines' && data.revealed) {
          data.revealed = new Set(data.revealed)
        }
        activeGames[row.game_key] = data
      } catch {}
    }
    console.log(`[persist] Loaded ${rows.length} active games from DB`)
  } catch (e) {
    console.error('[persist] Load failed:', e.message)
  }
}

async function saveGame(key, data) {
  const pool = getPool()
  if (!pool) return
  const serializable = { ...data }
  // Convert Set to array for JSON
  if (serializable.revealed instanceof Set) {
    serializable.revealed = [...serializable.revealed]
  }
  try {
    await pool.query(
      `INSERT INTO hk_active_games (game_key, game_data, updated_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE game_data = ?, updated_at = NOW()`,
      [key, JSON.stringify(serializable), JSON.stringify(serializable)]
    )
  } catch (e) {
    console.error('[persist] Save failed:', e.message)
  }
}

async function removeGame(key) {
  const pool = getPool()
  if (!pool) return
  try {
    await pool.query('DELETE FROM hk_active_games WHERE game_key = ?', [key])
  } catch {}
}

function getActiveGames() {
  return activeGames
}

function setActiveGame(key, data) {
  activeGames[key] = data
  saveGame(key, data)
}

function deleteActiveGame(key) {
  delete activeGames[key]
  removeGame(key)
}

function getActiveGame(key) {
  return activeGames[key]
}

module.exports = { loadGames, getActiveGames, setActiveGame, deleteActiveGame, getActiveGame }
