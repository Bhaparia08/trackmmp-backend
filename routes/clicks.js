const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// FIX #1 & #2: cap limit at 500 and validate date params
function parseUnixDate(str) {
  if (!str) return null;
  const ts = Math.floor(new Date(str) / 1000);
  return isNaN(ts) ? null : ts;
}

router.get('/', (req, res) => {
  const { campaign_id, publisher_id, status, platform, country, from, to,
          page = 1, limit = 50 } = req.query;

  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 50), 500);

  // admin sees all clicks; other roles see only their own
  const scope = req.user.role === 'admin'
    ? { clause: '1=1', params: [] }
    : { clause: 'cl.user_id = ?', params: [req.user.id] };
  const conditions = [scope.clause];
  const values = [...scope.params];

  if (campaign_id) { conditions.push('cl.campaign_id = ?'); values.push(campaign_id); }
  if (publisher_id) { conditions.push('cl.publisher_id = ?'); values.push(publisher_id); }
  if (status) { conditions.push('cl.status = ?'); values.push(status); }
  if (platform) { conditions.push('cl.platform = ?'); values.push(platform); }
  if (country) { conditions.push('cl.country = ?'); values.push(country); }
  const fromTs = parseUnixDate(from);
  const toTs   = parseUnixDate(to);
  if (fromTs !== null) { conditions.push('cl.created_at >= ?'); values.push(fromTs); }
  if (toTs   !== null) { conditions.push('cl.created_at <= ?'); values.push(toTs); }

  const where = conditions.join(' AND ');
  const offset = (Math.max(1, +page) - 1) * safeLimit;

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM clicks cl WHERE ${where}`).get(...values).cnt;
  const data = db.prepare(`
    SELECT cl.*, c.name AS campaign_name, p.name AS publisher_name
    FROM clicks cl
    LEFT JOIN campaigns c ON c.id = cl.campaign_id
    LEFT JOIN publishers p ON p.id = cl.publisher_id
    WHERE ${where}
    ORDER BY cl.created_at DESC LIMIT ? OFFSET ?
  `).all(...values, safeLimit, offset);

  res.json({ data, total, page: +page, limit: safeLimit });
});

module.exports = router;
