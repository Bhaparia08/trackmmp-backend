const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { campaign_id, publisher_id, status, platform, country, from, to,
          page = 1, limit = 50 } = req.query;

  const conditions = ['cl.user_id = ?'];
  const values = [req.user.id];

  if (campaign_id) { conditions.push('cl.campaign_id = ?'); values.push(campaign_id); }
  if (publisher_id) { conditions.push('cl.publisher_id = ?'); values.push(publisher_id); }
  if (status) { conditions.push('cl.status = ?'); values.push(status); }
  if (platform) { conditions.push('cl.platform = ?'); values.push(platform); }
  if (country) { conditions.push('cl.country = ?'); values.push(country); }
  if (from) { conditions.push('cl.created_at >= ?'); values.push(Math.floor(new Date(from)/1000)); }
  if (to) { conditions.push('cl.created_at <= ?'); values.push(Math.floor(new Date(to)/1000)); }

  const where = conditions.join(' AND ');
  const offset = (Math.max(1, +page) - 1) * +limit;

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM clicks cl WHERE ${where}`).get(...values).cnt;
  const data = db.prepare(`
    SELECT cl.*, c.name AS campaign_name, p.name AS publisher_name
    FROM clicks cl
    LEFT JOIN campaigns c ON c.id = cl.campaign_id
    LEFT JOIN publishers p ON p.id = cl.publisher_id
    WHERE ${where}
    ORDER BY cl.created_at DESC LIMIT ? OFFSET ?
  `).all(...values, +limit, offset);

  res.json({ data, total, page: +page, limit: +limit });
});

module.exports = router;
