/**
 * Tracking-URL macro translation + click_id auto-injection.
 *
 * Extracted from routes/integrations.js so that BOTH paths can use it:
 *   1. /api/integrations/fetch-offers (Offer Import flow)
 *   2. discoveryEngine.upsertCandidate (Discovery Hub auto-sync)
 *
 * Before this extraction, Discovery Hub stored tracking URLs with raw
 * platform-native macros (#s2#, [clickId], {sub1}, ...) — meaning every
 * candidate promoted to a live campaign via Discovery Hub had broken
 * click_id attribution. The extraction itself is a pure refactor (no
 * behavior change vs the prior in-place function); the win is that
 * discoveryEngine now also calls it.
 *
 * The function takes a tracking URL and a platform key, then:
 *   1. Translates the platform's macro syntax to our {macro} format
 *      (e.g. CAKE #s2# → {click_id}, Impact [clickId] → {click_id})
 *   2. If {click_id} is still absent after translation, AUTO-APPENDS the
 *      platform's canonical click-id query param (e.g. trackier → &p1=)
 *
 * Returns the URL unchanged for unknown platforms.
 */

function toOurMacros(url, platform, options = {}) {
  if (!url) return url;

  // If a fixed affiliate_id is provided (e.g. Apogeemobi's registered ID in a network),
  // embed it directly so it is never resolved as a dynamic macro.
  // Otherwise fall back to {pid} which track.js will substitute with the publisher token.
  const affiliateTarget = options.affiliate_id || '{pid}';

  // Per-platform translation tables  [ their_macro , our_macro ]
  const maps = {
    impact: [
      // click ID — THE most important: we put our click_id here so Impact returns it in postbacks
      ['[clickId]',         '{click_id}'],
      ['[CLICK_ID]',        '{click_id}'],
      ['[irclickid]',       '{click_id}'],
      ['[IRCLICKID]',       '{click_id}'],
      // Sub IDs
      ['[subId1]',          '{sub1}'],
      ['[subId2]',          '{sub2}'],
      ['[subId3]',          '{sub3}'],
      ['[subId4]',          '{sub4}'],
      ['[subId5]',          '{sub5}'],
      ['[SUB1]',            '{sub1}'],
      ['[SUB2]',            '{sub2}'],
      ['[SUB3]',            '{sub3}'],
      // Publisher / media partner
      ['[mediaPartner]',    '{pid}'],
      ['[MEDIA_PARTNER_ID]','{pid}'],
      ['[PUBLISHER_ID]',    '{pid}'],
      ['[publisherId]',     '{pid}'],
      // Device / geo
      ['[device]',          '{device_type}'],
      ['[DEVICE]',          '{device_type}'],
      ['[country]',         '{country}'],
      ['[COUNTRY]',         '{country}'],
      ['[advertisingId]',   '{advertising_id}'],
      ['[ADVERTISING_ID]',  '{advertising_id}'],
      ['[idfa]',            '{idfa}'],
      ['[IDFA]',            '{idfa}'],
      ['[gaid]',            '{gaid}'],
      ['[ip]',              '{ip}'],
    ],
    everflow: [
      // Everflow uses {macro} format — just rename their macros to ours.
      // {affiliate_id} is replaced with the fixed registered affiliate ID (from credentials),
      // or falls back to {pid} if no affiliate_id is configured.
      ['{transaction_id}',  '{click_id}'],
      ['{affiliate_id}',    affiliateTarget],
      ['{offer_id}',        '{campaign_id}'],
      ['{creative_id}',     '{creative_id}'],
      // sub1-sub5 already match, advertising_id already matches
    ],
    tune: [
      // Same treatment as Everflow: aff_id needs Apogeemobi's fixed affiliate account ID,
      // NOT the publisher token. Use affiliateTarget (fixed value or {pid} fallback).
      ['{transaction_id}',  '{click_id}'],
      ['{affiliate_id}',    affiliateTarget],
      ['{offer_id}',        '{campaign_id}'],
      // sub1-sub5 already match
    ],
    cityads: [
      ['{click_id}',        '{click_id}'],   // already matches
      ['{clickid}',         '{click_id}'],
      ['{webmaster_id}',    '{pid}'],
      ['{sub_id}',          '{sub1}'],
    ],
    appsflyer: [
      // AF uses {macro} — map their names to ours
      ['{clickid}',              '{click_id}'],
      ['{publisher_click_id}',   '{publisher_click_id}'],
      ['{af_sub1}',              '{sub1}'],
      ['{af_sub2}',              '{sub2}'],
      ['{af_sub3}',              '{sub3}'],
      ['{af_sub4}',              '{sub4}'],
      ['{af_sub5}',              '{sub5}'],
      ['{advertising_id}',       '{advertising_id}'],
    ],
    swaarm: [
      // Swaarm click-ID variations
      ['{pub_click_id}',    '{click_id}'],
      ['[pub_click_id]',    '{click_id}'],
      ['{clickid}',         '{click_id}'],
      ['[clickid]',         '{click_id}'],
      ['{click_id}',        '{click_id}'],    // already our format
      ['[click_id]',        '{click_id}'],
      // Publisher ID
      ['{pub_id}',          '{pid}'],
      ['[pub_id]',          '{pid}'],
      ['{publisher_id}',    '{pid}'],
      ['[publisher_id]',    '{pid}'],
      // Sub IDs
      ['{sub_id}',          '{sub1}'],
      ['{sub1}',            '{sub1}'],
      ['{sub2}',            '{sub2}'],
      ['{sub3}',            '{sub3}'],
      ['[sub1]',            '{sub1}'],
      ['[sub2]',            '{sub2}'],
      ['[sub3]',            '{sub3}'],
      // Offer / campaign ID
      ['{offer_id}',        '{campaign_id}'],
      ['[offer_id]',        '{campaign_id}'],
    ],
    admitad: [
      // Admitad deeplink subid params — these are already embedded as query params
      // when we construct the deeplink URL; no macro replacement needed here.
      // This entry is a no-op placeholder kept for consistency.
    ],
    trackier: [
      // Trackier convention: click_id is passed as &p1=, returned in postbacks as {p1}
      ['{your-transaction-id}', '{click_id}'],
      ['{your-click-id}',       '{click_id}'],
      ['{p1}',                  '{click_id}'],   // platform-side placeholder
      ['{your-sub-aff-id}',     '{pid}'],
      ['{sub-aff-id}',          '{pid}'],
      ['{source}',              '{pid}'],
      ['{p2}',                  '{sub1}'],
      ['{p3}',                  '{sub2}'],
      ['{gaid}',                '{gaid}'],
      ['{idfa}',                '{idfa}'],
    ],
    affise: [
      // Affise has NO click_id macro — convention is to pass click_id as {sub1}.
      // We rewrite Affise's typical placeholders to our macros and rely on the
      // auto-inject below to append &sub1={click_id} if not already present.
      ['{sub1}',          '{click_id}'],   // sub1 carries click_id by convention
      ['{sub2}',          '{sub1}'],
      ['{sub3}',          '{sub2}'],
      ['{partner_id}',    '{pid}'],
      ['{pid}',           '{pid}'],
      ['{gaid}',          '{gaid}'],
      ['{idfa}',          '{idfa}'],
      ['{country_code}',  '{country}'],
    ],
    clickdealer: [
      // ClickDealer is CAKE — same macros as Insparx/CAKE generic.
      // CAKE convention: click_id passed as &s2=, returned in postbacks as #s2#.
      ['#s2#',                '{click_id}'],
      ['{s2}',                '{click_id}'],
      ['#requested_action_id#','{goal_value}'],
      ['#price#',             '{payout}'],
      ['#received_amount#',   '{revenue}'],
      ['#s3#',                '{gaid}'],
      ['{s3}',                '{gaid}'],
      ['#s4#',                '{idfa}'],
      ['{s4}',                '{idfa}'],
      ['#s5#',                '{sub1}'],
      ['{s5}',                '{sub1}'],
      ['#affiliate_id#',      affiliateTarget],
      ['{affiliate_id}',      affiliateTarget],
    ],
    cake: [
      // Same as ClickDealer — every CAKE-powered network follows this macro convention.
      ['#s2#',                '{click_id}'],
      ['{s2}',                '{click_id}'],
      ['#requested_action_id#','{goal_value}'],
      ['#price#',             '{payout}'],
      ['#received_amount#',   '{revenue}'],
      ['#s3#',                '{gaid}'],
      ['{s3}',                '{gaid}'],
      ['#s4#',                '{idfa}'],
      ['{s4}',                '{idfa}'],
      ['#s5#',                '{sub1}'],
      ['{s5}',                '{sub1}'],
      ['#affiliate_id#',      affiliateTarget],
      ['{affiliate_id}',      affiliateTarget],
    ],
    insparx: [
      // Insparx is CAKE — same macros as ClickDealer/CAKE generic.
      // Same CAKE convention: click_id passed as &s2=, returned as #s2#.
      ['#s2#',                '{click_id}'],
      ['{s2}',                '{click_id}'],
      ['#requested_action_id#','{goal_value}'],
      ['#price#',             '{payout}'],
      ['#received_amount#',   '{revenue}'],
      ['#s3#',                '{gaid}'],
      ['{s3}',                '{gaid}'],
      ['#s4#',                '{idfa}'],
      ['{s4}',                '{idfa}'],
      ['#s5#',                '{sub1}'],
      ['{s5}',                '{sub1}'],
      ['#affiliate_id#',      affiliateTarget],
      ['{affiliate_id}',      affiliateTarget],
    ],
  };

  const pairs = maps[platform] || [];
  let result = url;
  for (const [from, to] of pairs) {
    // Case-insensitive replace for bracket-style macros; exact for curly-brace
    result = result.split(from).join(to);
  }

  // If {click_id} is still not in the URL after macro conversion, auto-inject it
  // using the canonical click_id param name for this platform.
  //
  // H1 fix (2026-05-31): if the URL already contains the bare param key as a
  // query parameter (e.g. ?sub1=somefixedvalue), REPLACE its value with
  // {click_id} instead of appending a duplicate. Duplicate query params are
  // ambiguous — different HTTP servers honor first/last/concat differently,
  // which can swap attribution to the wrong value. By convention, the
  // click-ID slot on these platforms is reserved for our click_id passthrough,
  // so replacing is the right semantic.
  if (result && !result.includes('{click_id}')) {
    const clickIdParams = {
      impact:      ['irclickid',     '{click_id}'],
      everflow:    ['transaction_id','{click_id}'],
      tune:        ['transaction_id','{click_id}'],
      cityads:     ['click_id',      '{click_id}'],
      appsflyer:   ['clickid',       '{click_id}'],
      swaarm:      ['pub_click_id',  '{click_id}'],
      admitad:     ['subid',         '{click_id}'],
      trackier:    ['p1',            '{click_id}'],  // Trackier's click_id convention
      affise:      ['sub1',          '{click_id}'],  // Affise has no click_id macro; sub1 carries it
      clickdealer: ['s2',            '{click_id}'],  // CAKE convention
      cake:        ['s2',            '{click_id}'],  // CAKE convention (any CAKE-powered network)
      insparx:     ['s2',            '{click_id}'],  // CAKE convention (Insparx is CAKE)
    };
    const entry = clickIdParams[platform];
    if (entry) {
      const [paramName, paramValue] = entry;
      // Detect bare param: ?paramName=... or &paramName=... (followed by & or end).
      // Anchored to start of query-string-element to avoid matching e.g.
      // ?my_p1=... when looking for `p1`.
      const bareParamRegex = new RegExp(`([?&])${paramName}=[^&]*`);
      if (bareParamRegex.test(result)) {
        // Replace the existing value — operator/platform may have left a
        // placeholder or empty value here; the click-ID slot must be ours.
        result = result.replace(bareParamRegex, `$1${paramName}=${paramValue}`);
      } else {
        // No bare param yet — append safely with ? or & as needed.
        result = result + (result.includes('?') ? '&' : '?') + `${paramName}=${paramValue}`;
      }
    }
  }

  return result;
}

module.exports = { toOurMacros };
