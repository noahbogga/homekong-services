// browser.js — Playwright Chrome launcher with stealth
// Uses system Google Chrome (channel: 'chrome') via iproyal residential proxy.
// Validated at 83% CF pass rate on stake.com with this exact setup.
//
// playwright-extra applies stealth via chromium.use() at module load time —
// no per-page call needed.

const { chromium } = require('playwright-extra')
const stealth = require('puppeteer-extra-plugin-stealth')
chromium.use(stealth())

const { freshProxyConfig } = require('./proxy')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
]

// Wait for CF challenge to clear (title stops containing "moment")
async function waitForCfClear(page, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const title = await page.title().catch(() => '')
    if (!title.toLowerCase().includes('moment')) return true
    await page.waitForTimeout(1000)
  }
  return false
}

// Run fn(page) with up to maxAttempts fresh proxy IPs.
// fn should return a result or throw. Returns first successful result.
async function withBrowser(fn, { maxAttempts = 8, url, waitMs = 5000 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let proxyConfig
    try {
      proxyConfig = await freshProxyConfig()
    } catch (e) {
      console.warn(`[browser] proxy config failed attempt ${attempt}: ${e.message}`)
      continue
    }

    const browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: CHROME_ARGS,
      proxy: proxyConfig,
      executablePath: '/usr/bin/google-chrome',
    })

    const ctx = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      timezoneId: 'Europe/Berlin',
      viewport: { width: 1600, height: 1000 },
      ignoreHTTPSErrors: true,   // iproyal proxy does SSL inspection
    })
    const page = await ctx.newPage()
    // stealth applied globally via chromium.use(stealth()) above — no per-page call needed

    try {
      if (url) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 })
        const cleared = await waitForCfClear(page)
        if (!cleared) {
          console.warn(`[browser] attempt ${attempt}: ${proxyConfig.server} CF blocked — retry`)
          await browser.close()
          continue
        }
        if (waitMs > 0) await page.waitForTimeout(waitMs)
      }

      const result = await fn(page, browser)
      await browser.close()
      return result
    } catch (err) {
      // Execution context destroyed = page re-rendered during evaluate — retry
      if (err.message.includes('Execution context was destroyed') ||
          err.message.includes('Target closed')) {
        console.warn(`[browser] attempt ${attempt}: context destroyed — retry`)
      } else {
        console.warn(`[browser] attempt ${attempt}: ${err.message.slice(0, 80)} — retry`)
      }
      await browser.close().catch(() => {})
    }
  }
  throw new Error(`withBrowser: all ${maxAttempts} attempts failed`)
}

module.exports = { withBrowser, waitForCfClear }
