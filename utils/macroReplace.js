/**
 * Replaces AppsFlyer-compatible AND Adjust-compatible macros in a postback URL.
 *
 * AppsFlyer macros: {click_id}, {advertising_id}, {idfa}, {idfv}, {android_id},
 *   {install_unix_ts}, {app_id}, {app_name}, {platform}, {country_code}, {language},
 *   {c}, {af_c_id}, {af_siteid}, {af_sub1}–{af_sub5}, {event_name}, {event_value},
 *   {revenue}, {currency}, {is_retargeting}, {blocked_reason}, {payout}
 *
 * Adjust macros: {adid}, {gps_adid}, {reftag}, {tracker_name}, {network_name},
 *   {campaign_name}, {adgroup_name}, {creative_name}, {is_organic},
 *   {att_status}, {google_app_set_id}
 */
function macroReplace(url, data) {
  if (!url) return url;

  const map = {
    // ── AppsFlyer macros ──────────────────────────────────────────────────────
    '{click_id}':           data.publisher_click_id || data.click_id || '',
    '{advertising_id}':     data.advertising_id || data.gps_adid || data.idfa || '',
    '{idfa}':               data.idfa || '',
    '{idfv}':               data.idfv || '',
    '{android_id}':         data.android_id || '',
    '{install_unix_ts}':    String(data.install_unix_ts || ''),
    '{app_id}':             data.bundle_id || '',
    '{app_name}':           data.app_name || '',
    '{platform}':           data.platform || '',
    '{country_code}':       data.country || '',
    '{language}':           data.language || '',
    '{c}':                  data.campaign_name || '',
    '{af_c_id}':            String(data.af_c_id || ''),
    '{af_siteid}':          data.af_siteid || '',
    '{af_sub1}':            data.af_sub1 || '',
    '{af_sub2}':            data.af_sub2 || '',
    '{af_sub3}':            data.af_sub3 || '',
    '{af_sub4}':            data.af_sub4 || '',
    '{af_sub5}':            data.af_sub5 || '',
    '{event_name}':         data.event_name || '',
    '{event_value}':        data.event_value ? encodeURIComponent(data.event_value) : '',
    '{revenue}':            String(data.revenue || '0'),
    '{currency}':           data.currency || 'USD',
    '{is_retargeting}':     data.is_retargeting ? 'true' : 'false',
    '{blocked_reason}':     data.blocked_reason || '',
    '{blocked_sub_reason}': data.blocked_sub_reason || '',
    '{payout}':             String(data.payout || '0'),

    // ── Adjust macros ─────────────────────────────────────────────────────────
    '{adid}':               data.adid || '',              // Adjust device ID
    '{gps_adid}':           data.gps_adid || '',          // Google Advertising ID
    '{reftag}':             data.reftag || '',             // Adjust reference tag
    '{tracker_name}':       data.tracker_name || '',       // Adjust tracker name
    '{network_name}':       data.network_name || data.pid || '',
    '{campaign_name}':      data.campaign_name || data.c || '',
    '{adgroup_name}':       data.adgroup_name || data.af_siteid || '',
    '{creative_name}':      data.creative_name || '',
    '{is_organic}':         data.is_organic ? '1' : '0',
    '{att_status}':         String(data.att_status || ''),
    '{google_app_set_id}':  data.google_app_set_id || '',
  };

  return Object.entries(map).reduce((u, [macro, val]) => u.split(macro).join(val), url);
}

module.exports = { macroReplace };
