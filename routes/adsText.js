// /api/ads-text — admin helper for ads.txt content per owned inventory.
// Each owned site needs to host its own /ads.txt declaring us as a seller.
// We can't do that for the third-party site — we generate the exact lines
// the user copies and pastes into their site's /ads.txt file.

const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'account_manager'));

const TRACKING_DOMAIN = (process.env.TRACKING_DOMAIN || 'https://track.apogeemobi.com')
  .replace(/^https?:\/\//, '').replace(/\/$/, '');

// Returns the lines for one inventory unit
router.get('/inventory/:id', (req, res) => {
  const inv = db.prepare(`
    SELECT i.id, i.name, i.domain, i.publisher_id, p.pub_token
    FROM owned_inventory i
    JOIN publishers p ON p.id = i.publisher_id
    WHERE i.id = ? AND i.status = 'active'
  `).get(Number(req.params.id));

  if (!inv) return res.status(404).json({ error: 'Inventory not found' });

  res.json({
    inventory: { id: inv.id, name: inv.name, domain: inv.domain },
    file_url:  inv.domain ? `https://${inv.domain}/ads.txt` : null,
    lines:     buildAdsText(inv),
    instructions: buildInstructions(inv),
  });
});

// Returns lines for ALL inventory (one block per site, for batch deployment)
router.get('/all', (_req, res) => {
  const all = db.prepare(`
    SELECT i.id, i.name, i.domain, i.publisher_id, p.pub_token
    FROM owned_inventory i
    JOIN publishers p ON p.id = i.publisher_id
    WHERE i.status = 'active'
    ORDER BY i.vertical, i.name
  `).all();

  res.json({
    sites: all.map(inv => ({
      id:       inv.id,
      name:     inv.name,
      domain:   inv.domain,
      file_url: inv.domain ? `https://${inv.domain}/ads.txt` : null,
      lines:    buildAdsText(inv),
    })),
    total: all.length,
  });
});

function buildAdsText(inv) {
  // Standard IAB ads.txt line format:
  //   <ad-system-domain>, <publisher-id>, <relationship>, <cert-authority-id?>
  // DIRECT = the seller (us) is the inventory owner's authorized direct seller.
  // We use pub-<id> as the seller_id, matching what we publish in sellers.json.
  const sellerId = `pub-${inv.publisher_id}`;
  return [
    `# ApogeeMobi TrackMMP — ads.txt for ${inv.name}`,
    `# Auto-generated. Add these lines verbatim to https://${inv.domain || inv.name}/ads.txt`,
    ``,
    `${TRACKING_DOMAIN}, ${sellerId}, DIRECT`,
  ];
}

function buildInstructions(inv) {
  if (!inv.domain) {
    return [
      'This inventory has no domain set — add a domain in Inventory > Edit first.',
    ];
  }
  return [
    `1) Create a file named "ads.txt" at the root of ${inv.domain}.`,
    `2) Paste the lines below into the file (UTF-8, no extra characters).`,
    `3) Verify the file is reachable at: https://${inv.domain}/ads.txt`,
    `4) Wait 24h — Google's crawler refreshes once a day.`,
  ];
}

module.exports = router;
