/**
 * Granular Campaign Permissions
 * Allows admins to grant specific users view-only or edit access to individual campaigns.
 * Useful for agency sub-accounts, read-only observers, or cross-advertiser reporting access.
 */

const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/permissions/campaign/:id — list all permission grants for a campaign
router.get('/campaign/:id', requireRole('admin', 'account_manager'), (req, res) => {
  const campaign = db.prepare('SELECT id, name, user_id FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const perms = db.prepare(`
    SELECT cp.*, u.name AS user_name, u.email AS user_email, u.role AS user_role,
           g.name AS granted_by_name
    FROM campaign_permissions cp
    JOIN users u ON u.id = cp.user_id
    LEFT JOIN users g ON g.id = cp.granted_by
    WHERE cp.campaign_id = ?
    ORDER BY cp.created_at DESC
  `).all(campaign.id);

  res.json(perms);
});

// PUT /api/permissions/campaign/:id — grant or update a user's permissions on a campaign
router.put('/campaign/:id', requireRole('admin', 'account_manager'), (req, res, next) => {
  try {
    const campaign = db.prepare('SELECT id FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { user_id, can_view = 1, can_edit = 0, can_manage = 0 } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const targetUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(user_id);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    db.prepare(`
      INSERT INTO campaign_permissions (campaign_id, user_id, can_view, can_edit, can_manage, granted_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id, user_id) DO UPDATE SET
        can_view = excluded.can_view, can_edit = excluded.can_edit,
        can_manage = excluded.can_manage, granted_by = excluded.granted_by
    `).run(campaign.id, user_id, can_view ? 1 : 0, can_edit ? 1 : 0, can_manage ? 1 : 0, req.user.id);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/permissions/campaign/:id/user/:user_id — revoke a user's permissions
router.delete('/campaign/:id/user/:user_id', requireRole('admin'), (req, res, next) => {
  try {
    db.prepare('DELETE FROM campaign_permissions WHERE campaign_id = ? AND user_id = ?')
      .run(req.params.id, req.params.user_id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/permissions/my-campaigns — list all campaigns the current user has explicit permission for
router.get('/my-campaigns', (req, res) => {
  const perms = db.prepare(`
    SELECT cp.*, c.name AS campaign_name, c.status AS campaign_status
    FROM campaign_permissions cp
    JOIN campaigns c ON c.id = cp.campaign_id
    WHERE cp.user_id = ? AND cp.can_view = 1
    ORDER BY c.name ASC
  `).all(req.user.id);
  res.json(perms);
});

module.exports = router;
