const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '10mb' }));

let browser = null;
let pages = {};

// Residential proxy config
const PROXY_CONFIG = {
  server: 'http://PROXY_HOST:63030',
  username: 'CHANGE_ME',
  password: 'CHANGE_ME',
};
const PROXY_CONFIG2 = {
  server: 'http://PROXY_HOST:63031',
  username: 'CHANGE_ME',
  password: 'CHANGE_ME',
};

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      proxy: PROXY_CONFIG,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      
    });
  }
  return browser;
}

app.post('/session', async (req, res) => {
  try {
    const b = await getBrowser();
    const useProxy = req.body.proxy !== false; // default: use proxy
    const context = await b.newContext({
      userAgent: req.body.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    pages[sessionId] = { page, context, lastUsed: Date.now() };
    res.json({ sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/session/:id', async (req, res) => {
  const s = pages[req.params.id];
  if (s) { await s.context.close(); delete pages[req.params.id]; }
  res.json({ ok: true });
});

app.post('/browse', async (req, res) => {
  const { sessionId, url, waitFor } = req.body;
  const s = pages[sessionId]; if (!s) return res.status(404).json({ error: 'session not found' });
  s.lastUsed = Date.now();
  try {
    await s.page.goto(url, { waitUntil: waitFor || 'domcontentloaded', timeout: 30000 });
    res.json({ title: await s.page.title(), url: s.page.url() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/click', async (req, res) => {
  const { sessionId, selector, text } = req.body;
  const s = pages[sessionId]; if (!s) return res.status(404).json({ error: 'session not found' });
  s.lastUsed = Date.now();
  try {
    if (text) await s.page.getByText(text, { exact: false }).first().click({ timeout: 10000 });
    else await s.page.click(selector, { timeout: 10000 });
    await s.page.waitForTimeout(500);
    res.json({ ok: true, url: s.page.url() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/type', async (req, res) => {
  const { sessionId, selector, text, clear } = req.body;
  const s = pages[sessionId]; if (!s) return res.status(404).json({ error: 'session not found' });
  s.lastUsed = Date.now();
  try {
    if (clear !== false) await s.page.fill(selector, '');
    await s.page.fill(selector, text);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/press', async (req, res) => {
  const { sessionId, key } = req.body;
  const s = pages[sessionId]; if (!s) return res.status(404).json({ error: 'session not found' });
  s.lastUsed = Date.now();
  try { await s.page.keyboard.press(key); await s.page.waitForTimeout(300); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/screenshot', async (req, res) => {
  const { sessionId, selector, fullPage } = req.body;
  const s = pages[sessionId]; if (!s) return res.status(404).json({ error: 'session not found' });
  s.lastUsed = Date.now();
  try {
    let buffer;
    if (selector) buffer = await s.page.locator(selector).screenshot();
    else buffer = await s.page.screenshot({ fullPage: fullPage || false });
    res.json({ image: buffer.toString('base64') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/evaluate', async (req, res) => {
  const { sessionId, script } = req.body;
  const s = pages[sessionId]; if (!s) return res.status(404).json({ error: 'session not found' });
  s.lastUsed = Date.now();
  try { const result = await s.page.evaluate(script); res.json({ result }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/text', async (req, res) => {
  const { sessionId, selector } = req.body;
  const s = pages[sessionId]; if (!s) return res.status(404).json({ error: 'session not found' });
  s.lastUsed = Date.now();
  try {
    const text = selector ? await s.page.locator(selector).textContent() : await s.page.locator('body').innerText();
    res.json({ text: (text || '').substring(0, 50000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/cookies/:id', async (req, res) => {
  const s = pages[req.params.id]; if (!s) return res.status(404).json({ error: 'session not found' });
  try { res.json({ cookies: await s.context.cookies() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/cookies/:id', async (req, res) => {
  const s = pages[req.params.id]; if (!s) return res.status(404).json({ error: 'session not found' });
  try { await s.context.addCookies(req.body.cookies); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/wait', async (req, res) => {
  const { sessionId, selector, timeout } = req.body;
  const s = pages[sessionId]; if (!s) return res.status(404).json({ error: 'session not found' });
  s.lastUsed = Date.now();
  try { await s.page.waitForSelector(selector, { timeout: timeout || 10000 }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/sessions', (req, res) => { res.json({ sessions: Object.keys(pages) }); });
app.get('/health', (req, res) => { res.json({ ok: true, sessions: Object.keys(pages).length }); });

// Cleanup inactive sessions (10 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(pages)) {
    if (now - s.lastUsed > 600000) { s.context.close().catch(()=>{}); delete pages[id]; }
  }
}, 60000);



// ===== INSTAGRAM SCRAPING (no login, public profiles) =====
app.post('/ig-scrape', async (req, res) => {
  const { username, category } = req.body;
  if (!username) return res.status(400).json({ error: 'missing username' });

  const sessionHash = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let context, page;

  try {
    const b = await getBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    page = await context.newPage();

    // Intercept GraphQL responses for data
    const graphqlData = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/graphql/query') || url.includes('/api/v1/')) {
        try {
          const json = await response.json();
          graphqlData.push({ url, data: json });
        } catch(e) {}
      }
    });

    const profileUrl = `https://www.instagram.com/${username}/`;
    await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Dismiss any cookie/login popups
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(b => {
        const t = b.textContent.toLowerCase();
        if (t.includes('allow') || t.includes('accept') || t.includes('decline') || t.includes('not now') || t.includes('essential')) b.click();
      });
      // Close login modal if it appears
      const closeBtn = document.querySelector('[aria-label="Close"]');
      if (closeBtn) closeBtn.click();
    });
    await page.waitForTimeout(1000);

    // Extract data based on category
    if (category === 'highlights') {
      const result = await extractHighlights(page, username, graphqlData);
      res.json(result);
    } else if (category === 'posts') {
      const result = await extractPosts(page, username, graphqlData);
      res.json(result);
    } else if (category === 'profile') {
      const result = await extractProfile(page, username, graphqlData);
      res.json(result);
    } else {
      res.json({ error: 'unsupported category: ' + category });
    }
  } catch(e) {
    res.json({ error: e.message, items: [] });
  } finally {
    if (context) await context.close().catch(()=>{});
  }
});

async function extractHighlights(page, username, graphqlData) {
  // Look for highlights in the page - they appear as circular thumbnails
  const highlights = await page.evaluate(() => {
    const results = [];
    // IG renders highlights as a horizontal list of circles above the grid
    // They are usually in a <ul> with role="list" or specific class patterns
    const hlItems = document.querySelectorAll('header ~ * li, [role="list"] li');
    hlItems.forEach(li => {
      const img = li.querySelector('img');
      const span = li.querySelector('span');
      if (img && span && span.textContent.trim()) {
        results.push({
          title: span.textContent.trim(),
          thumbnail: img.src || '',
          count: 0,
        });
      }
    });
    return results;
  });

  // Also check GraphQL data for highlight tray info
  for (const { data } of graphqlData) {
    const tray = data?.data?.user?.edge_highlight_reels?.edges
      || data?.data?.xdt_api__v1__highlights__user_feed?.edges
      || [];
    if (tray.length > 0) {
      return {
        isHighlightList: true,
        highlights: tray.map(e => ({
          title: e.node?.title || 'Untitled',
          count: e.node?.media_count || 0,
          id: (e.node?.id || '').replace('highlight:', ''),
          thumbnail: e.node?.cover_media?.thumbnail_src || e.node?.cover_media_cropped_thumbnail?.url || '',
        })),
        hasMore: false,
      };
    }
  }

  // Return DOM-scraped highlights if GraphQL didn't give us more
  if (highlights.length > 0) {
    return { isHighlightList: true, highlights, hasMore: false };
  }

  return { isHighlightList: true, highlights: [], hasMore: false, note: 'No highlights found (profile may be private)' };
}

async function extractPosts(page, username, graphqlData) {
  // Look for posts in GraphQL responses first
  for (const { data } of graphqlData) {
    const edges = data?.data?.user?.edge_owner_to_timeline_media?.edges
      || data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges
      || [];
    if (edges.length > 0) {
      const items = edges.map(e => {
        const node = e.node;
        return {
          thumbnail: node.thumbnail_src || node.display_url || (node.thumbnail_resources || []).pop()?.src || '',
          type: node.is_video ? 'video' : (node.__typename === 'GraphSidecar' ? 'mixed' : 'image'),
          mediaCount: node.edge_sidecar_to_children?.edges?.length || 1,
          shortcode: node.shortcode || '',
          url: node.video_url || node.display_url || '',
        };
      });
      return { items, hasMore: edges.length >= 12, isHighlightList: false };
    }
  }

  // Fallback: scrape from DOM
  const items = await page.evaluate(() => {
    const posts = [];
    const articles = document.querySelectorAll('article img, main a[href*="/p/"] img');
    articles.forEach(img => {
      if (img.src && !img.src.includes('profile_pic') && img.width > 50) {
        const link = img.closest('a');
        const shortcode = link ? (link.href.match(/\/p\/([^/]+)/)?.[1] || '') : '';
        posts.push({
          thumbnail: img.src,
          type: 'image',
          mediaCount: 1,
          shortcode,
        });
      }
    });
    return posts;
  });

  return { items, hasMore: items.length >= 12, isHighlightList: false };
}

async function extractProfile(page, username, graphqlData) {
  const profile = await page.evaluate(() => {
    const data = { username: '', fullName: '', bio: '', avatar: '', posts: 0, followers: 0, following: 0 };
    // Avatar
    const avatar = document.querySelector('header img');
    if (avatar) data.avatar = avatar.src;
    // Stats from meta or spans
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      const m = metaDesc.content.match(/(\d[\d,.]*[KMB]?) Followers.*(\d[\d,.]*[KMB]?) Following.*(\d[\d,.]*[KMB]?) Posts/i);
      if (m) { data.followers = m[1]; data.following = m[2]; data.posts = m[3]; }
    }
    // Title/name
    const title = document.querySelector('meta[property="og:title"]');
    if (title) data.fullName = title.content.split('(')[0].trim();
    return data;
  });
  return profile;
}

app.listen(3004, () => console.log('Browser service on :3004'));


// ===== SEARCH API (Brave + Google scrape fallback) =====
const BRAVE_KEYS = (process.env.BRAVE_API_KEYS || 'CHANGE_ME').split(',').filter(Boolean);
let braveIdx = 0;
function getNextBraveKey() { const k = BRAVE_KEYS[braveIdx % BRAVE_KEYS.length]; braveIdx++; return k; }

// Search cache (24h TTL)
const searchCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
function getCached(q) { const e = searchCache.get(q); if (e && Date.now() - e.ts < CACHE_TTL) return e.data; if (e) searchCache.delete(q); return null; }
function setCache(q, d) { searchCache.set(q, { data: d, ts: Date.now() }); if (searchCache.size > 500) { const old = [...searchCache.entries()].sort((a,b) => a[1].ts - b[1].ts); for (let i = 0; i < 100; i++) searchCache.delete(old[i][0]); } }

// POST /search — Brave Search API (fallback: Google scrape)
app.post('/search', async (req, res) => {
  const { query, count, freshness, fallback } = req.body;
  if (!query) return res.status(400).json({ error: 'missing query' });

  const cached = getCached(query);
  if (cached) return res.json({ ...cached, cached: true });

  // Try Brave first
  const key = getNextBraveKey();
  try {
    const params = new URLSearchParams({ q: query, count: count || 5 });
    if (freshness) params.set('freshness', freshness);
    const resp = await fetch(`https://YOUR_SEARCH_API_HOST/res/v1/web/search?${params}`, {
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key }
    });
    if (resp.ok) {
      const data = await resp.json();
      const results = (data.web?.results || []).map(r => ({
        title: r.title, url: r.url, snippet: r.description, age: r.age || ''
      }));
      const out = { source: 'brave', query, results };
      setCache(query, out);
      return res.json(out);
    }
    // If Brave fails (quota/error), fall through to scrape
    console.log('Brave search failed:', resp.status);
  } catch (e) { console.log('Brave search error:', e.message); }

  // Fallback: Google scrape via headless
  if (fallback === false) return res.json({ source: 'brave', query, results: [], error: 'Brave API failed, fallback disabled' });

  try {
    const b = await getBrowser();
    const ctx = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 }
    });
    const page = await ctx.newPage();
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${count || 5}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);

    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#search .g, #rso .g')).slice(0, 10).map(el => {
        const a = el.querySelector('a[href^="http"]');
        const title = el.querySelector('h3');
        const snippet = el.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]');
        if (!a || !title) return null;
        return { title: title.textContent, url: a.href, snippet: snippet ? snippet.textContent : '' };
      }).filter(Boolean);
    });
    await ctx.close();

    const out = { source: 'google-scrape', query, results };
    setCache(query, out);
    res.json(out);
  } catch (e) { res.status(500).json({ source: 'google-scrape', query, results: [], error: e.message }); }
});

// POST /deep-read — Fetch full page text content via headless
app.post('/deep-read', async (req, res) => {
  const { url, selector, maxLength } = req.body;
  if (!url) return res.status(400).json({ error: 'missing url' });
  try {
    const b = await getBrowser();
    const ctx = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 }
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    // Remove noise elements
    await page.evaluate(() => {
      const remove = ['nav', 'footer', 'header', '.sidebar', '.ad', '[role="banner"]', '[role="navigation"]', 'script', 'style', 'noscript'];
      remove.forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));
    });

    const text = selector
      ? await page.locator(selector).innerText().catch(() => '')
      : await page.locator('body').innerText();
    const title = await page.title();
    const finalUrl = page.url();
    await ctx.close();

    res.json({ title, url: finalUrl, text: (text || '').substring(0, maxLength || 30000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===== KNOWLEDGE BASE (Cloudflare AI Search) =====
const CF_ACCOUNT = 'CHANGE_ME';
const CF_EMAIL = 'CHANGE_ME';
const CF_KEY = 'CHANGE_ME';
const CF_INSTANCE = 'CHANGE_ME';

// POST /knowledge — search the knowledge base
app.post('/knowledge', async (req, res) => {
  const { query, maxResults } = req.body;
  if (!query) return res.status(400).json({ error: 'missing query' });
  try {
    const resp = await fetch(
      `https://YOUR_CF_API/client/v4/accounts/${CF_ACCOUNT}/ai-search/instances/${CF_INSTANCE}/search`,
      {
        method: 'POST',
        headers: {
          'X-Auth-Email': CF_EMAIL,
          'X-Auth-Key': CF_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, max_num_results: maxResults || 5 })
      }
    );
    const data = await resp.json();
    if (!data.success) return res.status(500).json({ error: data.errors || 'CF API error' });
    const chunks = (data.result?.chunks || []).map(c => ({
      score: c.score,
      text: c.text,
      source: c.item?.key || 'unknown'
    }));
    res.json({ query, results: chunks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
