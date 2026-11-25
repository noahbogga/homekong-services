// Simple in-memory rate limiter keyed by identifier (from request body or params)
// No external deps needed at this scale

const buckets = new Map()

const WINDOW_MS = 1000
const MAX_PER_WINDOW = 15

function getRateLimitKey(req) {
  // Try to extract player identifier from body or params
  return req.body?.identifier || req.params?.identifier || req.ip || 'unknown'
}

function rateLimit(req, res, next) {
  const key = getRateLimitKey(req)
  const now = Date.now()

  if (!buckets.has(key)) {
    buckets.set(key, { count: 1, windowStart: now })
    return next()
  }

  const bucket = buckets.get(key)
  if (now - bucket.windowStart > WINDOW_MS) {
    bucket.count = 1
    bucket.windowStart = now
    return next()
  }

  bucket.count++
  if (bucket.count > MAX_PER_WINDOW) {
    return res.status(429).json({ error: 'rate limited' })
  }

  next()
}

// Cleanup stale buckets every 60s
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 30000) buckets.delete(key)
  }
}, 60000)

module.exports = { rateLimit }
