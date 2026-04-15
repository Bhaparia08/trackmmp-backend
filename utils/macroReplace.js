/**
 * Unified macro replacement for AppsFlyer, Adjust, Branch, Impact, Rakuten postback URLs.
 */
function macroReplace(url, data) {
  if (!url) return url;

  const map = {
    // ── Core / Universal ─────────────────────────────────────────────────────
    '{click_id}':           data.publisher_click_id || data.click_id || '',
    '{transaction_id}':     data.click_id || data.publisher_click_id || '',
    '{our_click_id}':       data.click_id || '',
    '{payout}':             String(data.payout || '0'),
    '{revenue}':            String(data.revenue || '0'),
    '{currency}':           data.currency || 'USD',
    '{event_name}':         data.event_name || '',
    '{event_value}':        data.event_value ? encodeURIComponent(data.event_value) : '',
    '{goal_name}':          data.goal_name || '',
    '{goal_id}':            String(data.goal_id || ''),
    '{status}':             data.status || '',

    // ── Device identifiers ────────────────────────────────────────────────────
    '{advertising_id}':     data.advertising_id || data.gps_adid || data.idfa || '',
    '{idfa}':               data.idfa || '',
    '{idfv}':               data.idfv || '',
    '{android_id}':         data.android_id || '',
    '{gps_adid}':           data.gps_adid || data.advertising_id || '',
    '{adid}':               data.adid || '',
    '{google_app_set_id}':  data.google_app_set_id || '',
    '{att_status}':         String(data.att_status || ''),

    // ── App/Campaign ─────────────────────────────────────────────────────────
    '{app_id}':             data.bundle_id || '',
    '{app_name}':           data.app_name || '',
    '{bundle_id}':          data.bundle_id || '',
    '{platform}':           data.platform || '',
    '{c}':                  data.campaign_name || '',
    '{campaign_name}':      data.campaign_name || '',
    '{af_c_id}':            String(data.af_c_id || ''),
    '{campaign_id}':        String(data.af_c_id || ''),
    '{af_siteid}':          data.af_siteid || '',
    '{site_id}':            data.af_siteid || '',
    '{pid}':                data.pid || '',
    '{media_source}':       data.pid || '',
    '{network_name}':       data.pid || '',

    // ── Sub-parameters (AF sub1-5, Trackier sub1-10) ─────────────────────────
    '{af_sub1}': data.af_sub1 || '', '{sub1}': data.af_sub1 || '',
    '{af_sub2}': data.af_sub2 || '', '{sub2}': data.af_sub2 || '',
    '{af_sub3}': data.af_sub3 || '', '{sub3}': data.af_sub3 || '',
    '{af_sub4}': data.af_sub4 || '', '{sub4}': data.af_sub4 || '',
    '{af_sub5}': data.af_sub5 || '', '{sub5}': data.af_sub5 || '',
    '{sub6}':    data.sub6 || '',
    '{sub7}':    data.sub7 || '',
    '{sub8}':    data.sub8 || '',
    '{sub9}':    data.sub9 || '',
    '{sub10}':   data.sub10 || '',

    // ── Creative / Ad level ──────────────────────────────────────────────────
    '{creative_id}': data.creative_id || '',
    '{ad_id}':       data.ad_id || '',
    '{creative_name}': data.creative_name || '',
    '{adgroup_name}':  data.adgroup_name || data.af_siteid || '',

    // ── Geo / Device ─────────────────────────────────────────────────────────
    '{country_code}':  data.country || '',
    '{country}':       data.country || '',
    '{city}':          data.city || '',
    '{language}':      data.language || '',
    '{ip}':            data.ip || '',
    '{device_type}':   data.device_type || '',
    '{os}':            data.os || '',
    '{browser}':       data.browser || '',

    // ── Timestamps ───────────────────────────────────────────────────────────
    '{install_unix_ts}': String(data.install_unix_ts || ''),
    '{click_unix_ts}':   String(data.click_unix_ts || ''),

    // ── Retargeting/Fraud ────────────────────────────────────────────────────
    '{is_retargeting}':     data.is_retargeting ? 'true' : 'false',
    '{blocked_reason}':     data.blocked_reason || '',
    '{blocked_sub_reason}': data.blocked_sub_reason || '',

    // ── Adjust-specific ───────────────────────────────────────────────────────
    '{reftag}':          data.reftag || '',
    '{tracker_name}':    data.tracker_name || '',
    '{is_organic}':      data.is_organic ? '1' : '0',
    '{label}':           data.label || data.af_sub1 || '',
    '{adgroup}':         data.adgroup || data.af_siteid || '',
    '{creative}':        data.creative || data.creative_id || '',

    // ── Branch-specific ───────────────────────────────────────────────────────
    '{branch_click_id}':    data.branch_click_id || data.click_id || '',
    '{channel}':            data.channel || data.pid || '',
    '{feature}':            data.feature || '',
    '{campaign}':           data.campaign || data.campaign_name || '',
    '{stage}':              data.stage || '',
    '{tags}':               data.tags || '',

    // ── Impact Radius ─────────────────────────────────────────────────────────
    '{irclickid}':          data.irclickid || data.publisher_click_id || '',
    '{order_id}':           data.order_id || data.event_value || '',
    '{order_amount}':       String(data.revenue || data.payout || '0'),
    '{media_partner_id}':   data.media_partner_id || '',

    // ── Rakuten / LinkShare ───────────────────────────────────────────────────
    '{mid}':     data.mid || '',
    '{u1}':      data.u1 || data.af_sub1 || '',
    '{u2}':      data.u2 || data.af_sub2 || '',
    '{u3}':      data.u3 || data.af_sub3 || '',
    '{tr}':      data.tr || data.click_id || '',

    // ── Publisher / Affiliate ─────────────────────────────────────────────────
    '{aff_click_id}':        data.publisher_click_id || '',
    '{affiliate_id}':        String(data.publisher_id || ''),
    '{offer_id}':            String(data.campaign_id || data.af_c_id || ''),
    '{publisher_click_id}':  data.publisher_click_id || '',
    '{pub_click_id}':        data.publisher_click_id || '',
    '{pub_id}':              String(data.publisher_id || ''),
    '{event}':               data.event_name || data.event || 'install',
    '{event_type}':          data.event_name || data.event || 'install',
    '{goal}':                data.goal_name || data.event_name || '',
  };

  return Object.entries(map).reduce((u, [macro, val]) => u.split(macro).join(val), url);
}

module.exports = { macroReplace };
