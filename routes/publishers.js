const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { nanoid10 } = require('../utils/clickId');

const router = express.Router();
router.use(requireAuth);

// Account managers see their admin's data — look up admin via created_by
function getOwnerId(req) {
  if (req.user.role === 'account_manager') {
    const u = db.prepare('SELECT created_by FROM users WHERE id = ?').get(req.user.id);
    return u?.created_by || req.user.id;
  }
  return req.user.id;
}

router.get('/', (req, res) => {
  const ownerId = getOwnerId(req);
  const rows = db.prepare(`
    SELECT p.*, COUNT(c.id) AS click_count
    FROM publishers p
    LEFT JOIN clicks c ON c.publisher_id = p.id
    WHERE p.user_id = ? AND p.status != 'deleted' GROUP BY p.id ORDER BY p.created_at DESC
  `).all(ownerId);
  res.json(rows);
});

router.post('/', (req, res, next) => {
  try {
    const { name, email, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    // FIX #11: transaction makes seq_num read+insert atomic
    const insert = db.transaction(() => {
      const nextSeq = db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM publishers').get().n;
      return db.prepare(
        'INSERT INTO publishers (user_id, name, email, pub_token, notes, seq_num) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(req.user.id, name, email || null, nanoid10(), notes || null, nextSeq);
    });
    const result = insert();
    res.status(201).json(db.prepare('SELECT * FROM publishers WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM publishers WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: 'Publisher not found' });
  res.json(p);
});

router.put('/:id', (req, res, next) => {
  try {
    const p = db.prepare('SELECT * FROM publishers WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ error: 'Publisher not found' });
    const body = req.body;
    // FIX #6: explicit field resolution so empty string correctly clears a field
    const nameVal              = (body.name !== undefined && body.name) ? body.name : p.name; // name is NOT NULL — never blank it
    const emailVal             = 'email'             in body ? (body.email || null)             : p.email;
    const notesVal             = 'notes'             in body ? (body.notes || null)             : p.notes;
    const statusVal            = body.status             !== undefined ? (body.status || p.status)       : p.status;
    const postbackVal          = 'global_postback_url' in body ? (body.global_postback_url ?? '')        : p.global_postback_url;
    db.prepare('UPDATE publishers SET name=?, email=?, notes=?, status=?, global_postback_url=? WHERE id=?')
      .run(nameVal, emailVal, notesVal, statusVal, postbackVal, p.id);
    res.json(db.prepare('SELECT * FROM publishers WHERE id = ?').get(p.id));
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const p = db.prepare('SELECT * FROM publishers WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ error: 'Publisher not found' });
    // FIX #3: soft-delete — preserve click history, just hide from UI
    db.prepare("UPDATE publishers SET status='deleted' WHERE id = ?").run(p.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
