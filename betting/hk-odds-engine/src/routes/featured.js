const express = require('express')
const { getFeatured } = require('../featured')

const router = express.Router()

// GET /featured?category=<id> — curated hot matches for one category (soccer,
// basketball, ice_hockey, mma, boxing, politics). No category -> the flat `all` set.
router.get('/', (req, res) => {
  const category = req.query.category || null
  res.json({ featured: getFeatured(category) })
})

module.exports = router
