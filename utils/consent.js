// Consent helpers — GDPR/CCPA jurisdiction detection + state parsing.
//
// We don't ship a full CMP.  We:
//   1) Tell the SDK whether the visitor's country requires consent.
//   2) Accept a consent_state string from the SDK and respect it.
//   3) Audit-log consent events in `visitor_consent`.
//
// Recognized states:
//   'accepted'  — explicit accept (cookies + personalization OK)
//   'rejected'  — explicit reject (no tracking cookies, serve contextual only)
//   'limited'   — partial (functional only)
//   'tcf:<str>' — IAB TCF v2.2 consent string (we forward; advertisers parse)
//   ''          — not yet decided (banner should show)

const GDPR_COUNTRIES = new Set([
  // EU 27
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE',
  'IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  // EEA / GDPR-aligned
  'IS','LI','NO',
  // UK GDPR
  'GB',
  // Swiss FADP (effectively aligned)
  'CH',
]);

const CCPA_REGIONS = new Set(['US-CA']); // future-proof for state-level checks

function requiresConsent(country, region) {
  if (!country) return false;
  const c = country.toUpperCase();
  if (GDPR_COUNTRIES.has(c)) return 'gdpr';
  if (region && CCPA_REGIONS.has(`${c}-${region.toUpperCase()}`)) return 'ccpa';
  return false;
}

function normalizeConsent(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const t = raw.trim();
  if (t.startsWith('tcf:') || t.startsWith('CQ') || t.startsWith('CP')) return t.startsWith('tcf:') ? t : `tcf:${t}`;
  const lc = t.toLowerCase();
  if (['accepted','accept','yes','true','1'].includes(lc)) return 'accepted';
  if (['rejected','reject','deny','no','false','0'].includes(lc)) return 'rejected';
  if (['limited','partial','functional'].includes(lc)) return 'limited';
  return '';
}

// Returns true if the consent state permits serving personalized offers.
// 'rejected' or empty under GDPR = no personalization.
function permitsPersonalization(consentState, jurisdiction) {
  const n = normalizeConsent(consentState);
  if (!jurisdiction) return true;            // outside consent regime
  if (n === 'accepted') return true;
  if (n.startsWith('tcf:')) return true;     // assume TCF accepted; advertisers must re-check
  return false;
}

module.exports = {
  GDPR_COUNTRIES,
  requiresConsent,
  normalizeConsent,
  permitsPersonalization,
};
