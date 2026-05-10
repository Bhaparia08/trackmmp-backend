/**
 * Inventory matcher — rule-based scoring of a candidate offer against
 * the platform's owned inventory.
 *
 * Returns the best inventory match plus a per-dimension breakdown so
 * the UI can show "why this score is X."
 *
 * No ML — deliberately. We don't have enough imported-and-paid-out data
 * yet for any model to outperform tuned weights. Revisit after 6+ months.
 */
const db = require('../db/init');

const W = {
  vertical:        0.25,
  geo_overlap:     0.20,
  device_overlap:  0.15,
  payout:          0.15,
  historical_lift: 0.15,
  traffic_type:    0.10,
};

function jaccard(aArr, bArr) {
  const a = new Set((aArr || []).map(s => String(s).toLowerCase()));
  const b = new Set((bArr || []).map(s => String(s).toLowerCase()));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  return inter / new Set([...a, ...b]).size;
}

function scoreVertical(candVertical, invVertical) {
  if (!candVertical || !invVertical) return 0;
  if (candVertical.toLowerCase() === invVertical.toLowerCase()) return 1.0;
  // Related-vertical fallback — coarse mapping
  const groups = [
    ['betting', 'gambling', 'casino', 'sports'],
    ['finance', 'crypto', 'fintech', 'banking', 'forex', 'trading'],
    ['insurance', 'health-insurance'],
    ['health', 'wellness', 'nutra', 'pharma'],
    ['ecommerce', 'e-commerce', 'retail', 'shopping'],
  ];
  const c = candVertical.toLowerCase();
  const i = invVertical.toLowerCase();
  for (const g of groups) {
    if (g.includes(c) && g.includes(i)) return 0.5;
  }
  return 0;
}

function scoreGeo(candCountries, invGeo) {
  if (!candCountries?.length) return 0.5;       // unrestricted offers — neutral
  if (!invGeo) return 0.3;
  // invGeo can be a single country or a comma-list
  const invList = String(invGeo).split(/[, ]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!invList.length) return 0.5;
  const candUpper = candCountries.map(c => String(c).toUpperCase());
  let hit = 0;
  for (const c of invList) if (candUpper.includes(c)) hit++;
  return hit / invList.length;
}

function scoreDevice(candDevices, invType) {
  if (!candDevices?.length) return 0.7;        // neutral when offer doesn't restrict
  const cand = candDevices.map(d => String(d).toLowerCase());
  const inv  = (invType || '').toLowerCase();
  // Inventory `type` is loose (e.g. "site", "app-ios"). Heuristic match.
  if (cand.includes('mobile') && (inv.includes('app') || inv.includes('mobile'))) return 1.0;
  if (cand.includes('desktop') && inv.includes('site')) return 0.9;
  if (cand.includes('desktop') && inv.includes('web')) return 0.9;
  return 0.6;
}

function scorePayout(candidate, peers) {
  if (!candidate?.payout || !peers?.length) return 0.6;
  const sorted = [...peers].sort((a, b) => a - b);
  const idx = sorted.findIndex(p => candidate.payout <= p);
  const pct = idx === -1 ? 1.0 : idx / sorted.length;
  return Math.min(1, 0.4 + 0.6 * pct);          // 40% floor for any non-zero payout
}

function scoreHistoricalLift(_candidate, _inv) {
  // Placeholder — Phase 2 reads from `daily_stats` joined back to imported
  // candidates from this advertiser. For Phase 1, neutral 0.5 keeps the
  // model honest without pretending to know.
  return 0.5;
}

function scoreTrafficType(_candidate, _inv) {
  return 0.7;                                   // neutral until inventory grows traffic-type metadata
}

/**
 * Score a candidate against every active owned-inventory row and return
 * the best match.
 *
 * @param {object} candidate  normalized offer (NormalizedOffer shape)
 * @returns {{ best_inventory_id: number|null, score: number, breakdown: object }}
 */
function score(candidate) {
  let inventories = [];
  try {
    inventories = db.prepare(`
      SELECT id, name, vertical, geo, type
      FROM owned_inventory
      WHERE status = 'active'
    `).all();
  } catch {
    return { best_inventory_id: null, score: 0, breakdown: { reason: 'no inventory table' } };
  }
  if (!inventories.length) {
    return { best_inventory_id: null, score: 0, breakdown: { reason: 'no active inventory' } };
  }

  // Peer-payout pool — same vertical across candidate_candidates we've already seen
  let peers = [];
  try {
    peers = db.prepare(`
      SELECT payout FROM campaign_candidates
      WHERE vertical = ? AND payout > 0 AND payout < 1000
      ORDER BY first_seen_at DESC LIMIT 200
    `).all(candidate.vertical || '').map(r => Number(r.payout));
  } catch {}

  let best = null;
  for (const inv of inventories) {
    const v = scoreVertical(candidate.vertical, inv.vertical);
    const g = scoreGeo(candidate.allowed_countries, inv.geo);
    const d = scoreDevice(candidate.allowed_devices, inv.type);
    const p = scorePayout(candidate, peers);
    const h = scoreHistoricalLift(candidate, inv);
    const t = scoreTrafficType(candidate, inv);

    const total = (W.vertical * v) + (W.geo_overlap * g) + (W.device_overlap * d)
                + (W.payout * p) + (W.historical_lift * h) + (W.traffic_type * t);
    const total100 = Math.round(total * 100);

    const breakdown = {
      vertical:        Number(v.toFixed(2)),
      geo_overlap:     Number(g.toFixed(2)),
      device_overlap:  Number(d.toFixed(2)),
      payout:          Number(p.toFixed(2)),
      historical_lift: Number(h.toFixed(2)),
      traffic_type:    Number(t.toFixed(2)),
    };

    if (!best || total100 > best.score) {
      best = { best_inventory_id: inv.id, inventory_name: inv.name, score: total100, breakdown };
    }
  }

  return best || { best_inventory_id: null, score: 0, breakdown: {} };
}

module.exports = { score };
