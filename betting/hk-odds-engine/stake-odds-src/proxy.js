// proxy.js — proxy-provider pull-fresh helper
// Pattern: pull 1 IP per use, use immediately, discard. Each IP:port expires ~10s idle.
// DO NOT batch-pull and reuse — the port dies before you get to it.

const PROXY_API =
  'https://YOUR_PROXY_PROVIDER_API' +
  '?app_key=CHANGE_ME' +
  '&pt=22&num=1&cc=DE&life=30&protocol=1&format=txt&lb=%5Cr%5Cn'

const https = require('https')

function pullFreshProxy() {
  return new Promise((resolve, reject) => {
    https.get(PROXY_API, (res) => {
      let body = ''
      res.on('data', d => { body += d })
      res.on('end', () => {
        const line = body.split(/\r?\n/).map(l => l.trim()).find(l => l.includes(':'))
        if (!line) return reject(new Error('iproyal returned no proxy line: ' + body.slice(0, 80)))
        const [host, port] = line.split(':')
        if (!host || !port) return reject(new Error('bad proxy format: ' + line))
        resolve({ host, port: parseInt(port, 10), raw: line })
      })
    }).on('error', reject)
  })
}

// Returns { server } object suitable for Playwright's proxy option
async function freshProxyConfig() {
  const { raw } = await pullFreshProxy()
  return { server: 'http://' + raw }
}

module.exports = { pullFreshProxy, freshProxyConfig }
