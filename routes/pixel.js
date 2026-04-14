const express = require('express');
const db = require('../db/init');

const router = express.Router();

// 1x1 transparent GIF pixel
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// GET /pixel.gif?cid={click_id}&event={event}&payout={payout}
router.get('/', (req, res, next) => {
  try {
    const { cid, event = 'lead', payout = 0 } = req.query;

    if (cid) {
      const click = db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(cid);
      if (click) {
        const alreadyDone = db.prepare(
          "SELECT id FROM postbacks WHERE click_id = ? AND event_type = ? AND status = 'attributed'"
        ).get(cid, event);

        if (!alreadyDone) {
          db.prepare(`INSERT INTO postbacks (click_id, campaign_id, user_id, event_type, payout, status, raw_params)
            VALUES (?,?,?,?,?,'attributed',?)`)
            .run(cid, click.campaign_id, click.user_id, event, +payout, JSON.stringify(req.query));

          db.prepare("UPDATE clicks SET status = ? WHERE click_id = ?").run(
            event === 'install' ? 'installed' : 'converted', cid
          );

          db.prepare(`INSERT INTO daily_stats (user_id, app_id, campaign_id, publisher_id, date, leads)
            VALUES (?,?,?,?,date('now'),1)
            ON CONFLICT(user_id, app_id, campaign_id, publisher_id, date)
            DO UPDATE SET leads = leads + 1`)
            .run(click.user_id, 0, click.campaign_id, click.publisher_id||0);
        }
      }
    }

    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache', 'Pragma': 'no-cache' });
    res.send(GIF_1X1);
  } catch (err) { next(err); }
});

module.exports = router;
