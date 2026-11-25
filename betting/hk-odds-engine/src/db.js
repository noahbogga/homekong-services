const mysql = require('mysql2/promise')

let pool = null

async function initDB() {
  pool = mysql.createPool({
    host: process.env.DB_HOST || '192.168.50.235',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'qbcoreframework',
    waitForConnections: true,
    connectionLimit: 10,
  })
  const [rows] = await pool.query('SELECT 1')
  console.log('[db] Connected to MySQL (' + (process.env.DB_NAME || 'default') + ')')

  // Schema init — idempotent. Engine now owns the betting schema (zx_wxyz_stream).
  // Folds in the ALTER TABLEs that used to live in the resource (bets.lua/casino.lua).
  // ZQ columns (zq_home_cn/zq_away_cn/handicap_line) let settlement match ZQ results.
  await pool.query(`
    ALTER TABLE hk_sportsbets
    ADD COLUMN IF NOT EXISTS commence_time TIMESTAMP NULL,
    ADD COLUMN IF NOT EXISTS payout INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS paid_out TINYINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS demo TINYINT(1) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS zq_home_cn VARCHAR(64) NULL,
    ADD COLUMN IF NOT EXISTS zq_away_cn VARCHAR(64) NULL,
    ADD COLUMN IF NOT EXISTS handicap_line DECIMAL(4,2) NULL
  `)
  await pool.query(`
    ALTER TABLE hk_casinobets
    ADD COLUMN IF NOT EXISTS nonce INT DEFAULT 0
  `).catch(e => console.error('[db] casinobets alter:', e.message))

  // channel: 'ingame' (default) vs 'mobile' (web/PWA). Phase 3: BOTH channels now
  // pay real game cash via the relay's payout pull — mobile bets debit real cash at
  // placement (applyCash) and settle through the same /payouts path as ingame, so
  // the relay's pull no longer filters to 'ingame'. wallet_paid is the legacy escrow
  // flag (dormant). debit_key is the applyCash idempotency key from placement.
  await pool.query(`
    ALTER TABLE hk_sportsbets
    ADD COLUMN IF NOT EXISTS channel VARCHAR(12) NOT NULL DEFAULT 'ingame',
    ADD COLUMN IF NOT EXISTS wallet_paid TINYINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS debit_key VARCHAR(80) DEFAULT NULL
  `).catch(e => console.error('[db] sportsbets channel alter:', e.message))

  // debit_key uniqueness = placement idempotency. A mobile placement carries a
  // client-generated key; if the same key arrives twice (dropped-response retry,
  // double-tap) we must NOT insert a second bet or debit again. The UNIQUE index
  // makes the second insert fail so the handler can replay the first bet instead.
  // NULL repeats freely (all legacy/ingame rows), so this only constrains mobile
  // placements. Guarded: ignore "dup key name" if the index already exists.
  await pool.query(`
    ALTER TABLE hk_sportsbets ADD UNIQUE KEY uniq_debit_key (debit_key)
  `).catch(e => {
    if (!/Duplicate key name/i.test(e.message)) console.error('[db] sportsbets debit_key index:', e.message)
  })

  // Local identity mirror. PUSHED by the hk-sportsbetting resource via
  // POST /steak/identity from live QBCore PlayerData (charinfo/job/money) — the
  // engine holds NO game-DB credentials and never queries .235/homekong. The panel
  // reads THIS local copy so no cross-DB query happens per request. See
  // [[zx-betting-db]] isolation.
  // NOTE: collation MUST match hk_steak_vip.identifier (utf8mb4_unicode_ci) or the
  // LEFT JOIN in the panel queries throws "Illegal mix of collations". MariaDB's
  // default (utf8mb4_uca1400_ai_ci) differs, so pin it explicitly.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hk_player_identity (
      identifier   VARCHAR(64) PRIMARY KEY,
      char_name    VARCHAR(128) NULL,
      cid          VARCHAR(16)  NULL,
      job          VARCHAR(64)  NULL,
      job_grade    VARCHAR(64)  NULL,
      cash         BIGINT NULL,
      bank         BIGINT NULL,
      synced_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `).catch(e => console.error('[db] identity table:', e.message))
  // Repair collation on tables created before the pin above (idempotent).
  await pool.query(
    `ALTER TABLE hk_player_identity CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  ).catch(e => console.error('[db] identity collation fix:', e.message))

  // ── MOBILE / WEB MIRROR ────────────────────────────────────────
  // Lets a player use the Steak NUI from a browser/PWA while OFFLINE in-game.
  // Money authority stays on the .235 relay (only it can touch the game `players`
  // table); the engine holds an ESCROW wallet in this isolated betting DB and all
  // web play runs against that wallet. Only load/cashout ever cross to the relay,
  // via the queue table below. See [[zx-betting-db]] isolation.
  //
  // hk_mobile_auth: one row per character. Stores a per-player web key HASH
  // (never the raw key) pushed one-way from the relay's hk-hub key panel. key_ver
  // bumps on regenerate so all prior sessions invalidate at once.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hk_mobile_auth (
      identifier   VARCHAR(64) PRIMARY KEY,
      login_id     VARCHAR(32) NULL,
      key_hash     VARCHAR(128) NOT NULL,
      key_salt     VARCHAR(64)  NOT NULL,
      key_ver      INT NOT NULL DEFAULT 1,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_login (login_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `).catch(e => console.error('[db] mobile_auth table:', e.message))

  // hk_mobile_session: short-lived bearer tokens. token_hash is sha256 of the raw
  // token we hand the browser (raw token never stored). Bound to key_ver so a
  // regenerate orphans them; a cleanup on login drops expired rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hk_mobile_session (
      token_hash   CHAR(64) PRIMARY KEY,
      identifier   VARCHAR(64) NOT NULL,
      key_ver      INT NOT NULL DEFAULT 1,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at   TIMESTAMP NOT NULL,
      last_seen    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_ident (identifier)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `).catch(e => console.error('[db] mobile_session table:', e.message))

  // hk_mobile_wallet: escrow balance the web player bets against. balance is the
  // engine's authoritative figure (in whole dollars). Loaded from / cashed out to
  // game cash through the queue below.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hk_mobile_wallet (
      identifier   VARCHAR(64) PRIMARY KEY,
      balance      BIGINT NOT NULL DEFAULT 0,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `).catch(e => console.error('[db] mobile_wallet table:', e.message))

  // hk_mobile_queue: the ONLY money-authority crossing. The web layer enqueues a
  // load (game cash -> wallet) or cashout (wallet -> game cash) request; the .235
  // relay polls /mobile/pending, moves game cash via its offline players-table
  // write path, and acks. status: pending -> claimed -> done | failed. The engine
  // moves the wallet side only AFTER the relay confirms the game-cash side.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hk_mobile_queue (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      identifier   VARCHAR(64) NOT NULL,
      kind         ENUM('load','cashout') NOT NULL,
      amount       BIGINT NOT NULL,
      status       ENUM('pending','claimed','done','failed') NOT NULL DEFAULT 'pending',
      reason       VARCHAR(128) NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      claimed_at   TIMESTAMP NULL,
      done_at      TIMESTAMP NULL,
      KEY idx_status (status),
      KEY idx_ident (identifier)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `).catch(e => console.error('[db] mobile_queue table:', e.message))

  // hk_mobile_mirror: a READ-ONLY reflection of the player's REAL in-game cash
  // (.235 game DB, which the engine may never read directly). The relay pushes the
  // current cash here (POST /mobile/mirror) on session start, on every in-game cash
  // change, and via a periodic sweep. The web app reads this as the balance, so one
  // number shows everywhere. This is the source of truth for DISPLAY; real money
  // still lives on the game DB and is only ever edited by the relay.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hk_mobile_mirror (
      identifier   VARCHAR(64) PRIMARY KEY,
      cash         BIGINT NOT NULL DEFAULT 0,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `).catch(e => console.error('[db] mobile_mirror table:', e.message))

  // hk_mobile_presence: single-session mutex. web_active=1 while a browser session
  // is live (set on login, refreshed by a heartbeat). The in-game client asks the
  // relay -> engine whether the player's web session is active; if so the in-game
  // UI shows a lock screen (mobile has priority). A stale web_seen_at (older than
  // the stale window) counts as inactive so a crashed/closed tab frees the lock.
  // web_token_hash pins which session owns the lock so a takeover can target it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hk_mobile_presence (
      identifier      VARCHAR(64) PRIMARY KEY,
      web_active      TINYINT NOT NULL DEFAULT 0,
      web_seen_at     TIMESTAMP NULL DEFAULT NULL,
      web_token_hash  VARCHAR(64) NULL DEFAULT NULL,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `).catch(e => console.error('[db] mobile_presence table:', e.message))

  // In-game PRIORITY (inverts the old web-priority mutex). The in-game casino
  // client is authoritative: while it has the casino UI open it publishes
  // ingame_active=1 (relay -> POST /mobile/ingame), refreshed by a ~10s heartbeat.
  // The web session reads this via its own heartbeat and SUSPENDS while set. A
  // stale ingame_seen_at (older than the stale window) counts as inactive so a
  // crash/disconnect that skips the clear self-releases -> web resumes (fail-safe).
  await pool.query(`
    ALTER TABLE hk_mobile_presence
    ADD COLUMN IF NOT EXISTS ingame_active  TINYINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ingame_seen_at TIMESTAMP NULL DEFAULT NULL
  `).catch(e => console.error('[db] mobile_presence ingame alter:', e.message))

  console.log('[db] Schema updated')
}

function getPool() {
  return pool
}

module.exports = { initDB, getPool }
