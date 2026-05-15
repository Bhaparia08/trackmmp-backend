// /sellers.json — IAB OpenRTB Sellers.json spec
// https://iabtechlab.com/wp-content/uploads/2019/07/Sellers.json_Final.pdf
//
// Hosted at https://track.apogeemobi.com/sellers.json (publicly cacheable).
// Declares every publisher whose inventory we monetize.  This is what
// premium SSPs (Magnite, PubMatic, OpenX, Google AdX) fetch to verify that
// our supply path is legitimate — without this, programmatic spend simply
// does not flow.

const express = require('express');
const db = require('../db/init');

const router = express.Router();

router.get('/', (_req, res) => {
  const publishers = db.prepare(`
    SELECT p.id, p.name, p.pub_token, p.website_url
    FROM publishers p
    WHERE EXISTS (
      SELECT 1 FROM owned_inventory i
      WHERE i.publisher_id = p.id AND i.status = 'active'
    )
    ORDER BY p.id ASC
  `).all();

  const contact = process.env.SELLERS_CONTACT_EMAIL || 'ads@apogeemobi.com';
  const identifierUrl = process.env.TRACKING_DOMAIN || 'https://track.apogeemobi.com';

  res.json({
    contact_email:     contact,
    contact_address:   process.env.SELLERS_CONTACT_ADDRESS || '',
    version:           '1.0',
    identifier_url:    identifierUrl,
    sellers: publishers.map(p => {
      // Strip protocol + trailing slash from website_url to get the bare
      // domain in IAB sellers.json format.
      const fromUrl = String(p.website_url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return {
        seller_id:   `pub-${p.id}`,
        name:        p.name,
        domain:      fromUrl || extractDomainFromInventory(p.id),
        seller_type: 'PUBLISHER',
        is_confidential: 0,
      };
    }),
  });
});

function extractDomainFromInventory(publisherId) {
  const inv = db.prepare(`
    SELECT domain FROM owned_inventory
    WHERE publisher_id = ? AND status = 'active' AND domain IS NOT NULL AND domain != ''
    ORDER BY id ASC LIMIT 1
  `).get(publisherId);
  return inv?.domain || '';
}

module.exports = router;
