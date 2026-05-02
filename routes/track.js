const express = require('express');
const db = require('../db/init');
const { nanoid16 } = require('../utils/clickId');
const { parseDevice } = require('../utils/deviceParser');
const { lookupCountry } = require('../utils/geoip');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const clickLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const impLimiter   = rateLimit({ windowMs: 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false });

// GET /track/click/:campaign_token
router.get('/click/:campaign_token', clickLimiter, async (req, res, next) => {
  try {
    const campaign = db.prepare(
      "SELECT * FROM campaigns WHERE campaign_token = ? AND status = 'active'"
    ).get(req.params.campaign_token);

    // FIX #10: friendly message for inactive/unknown campaign token
    if (!campaign) return res.status(404).send('This tracking link is no longer active. Please contact your account manager.');

    const q = req.query;
    const ua = req.headers['user-agent'] || '';
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const country = await lookupCountry(ip);
    const { device_type, os, browser, platform } = parseDevice(ua);
    const language = req.headers['accept-language']?.split(',')[0] || '';

    // Resolve publisher
    let publisher_id = null;
    if (q.pid) {
      const pub = db.prepare('SELECT id FROM publishers WHERE pub_token = ? AND user_id = ?')
        .get(q.pid, campaign.user_id);
      if (pub) publisher_id = pub.id;
    }

    // ── Preview / test bypass ──────────────────────────────────────────────────
    // If the correct campaign security_token is provided, skip all access and
    // geo checks so the campaign can be fully tested regardless of visibility.
    const previewBypass = !!(q.security_token && q.security_token === campaign.security_token);

    // ── Visibility / access check ──────────────────────────────────────────────
    const visibility = campaign.visibility || 'open';
    if (!previewBypass) {
      if (visibility === 'private') {
        return res.status(403).send('This campaign is not available.');
      }
      if (visibility === 'approval_required') {
        if (!publisher_id) return res.status(403).send('Access to this campaign requires approval. Contact your account manager.');
        const access = db.prepare(
          "SELECT status FROM campaign_access_requests WHERE campaign_id = ? AND publisher_id = ?"
        ).get(campaign.id, publisher_id);
        if (!access || access.status !== 'approved') {
          return res.status(403).send('Your access to this campaign is pending approval. Clicks are paused until approved.');
        }
      }
    }

    // Support all major click ID param names across all platforms.
    // Order matters: more specific / unambiguous names first, generic fallbacks last.
    //   clickid        — standard / AppsFlyer / Adjust (most common)
    //   click_id       — generic
    //   transaction_id — TUNE / HasOffers / Trackier / Everflow
    //   irclickid      — Impact Radius
    //   pub_click_id   — Swaarm
    //   aff_click_id   — HasOffers / TUNE alternative
    //   aff_sub        — HasOffers sub passthrough (used as click ID by some advertisers)
    //   subid          — Admitad
    //   u1             — Rakuten LinkShare
    const publisher_click_id = q.clickid || q.click_id || q.transaction_id || q.irclickid || q.pub_click_id || q.aff_click_id || q.aff_sub || q.subid || q.u1 || null;

    // Support Adjust's gps_adid, idfa, adid
    const advertising_id = q.advertising_id || q.gps_adid || q.idfa || q.adid || null;

    // ── Geo-targeting check ──────────────────────────────────────────────────
    // If campaign has allowed_countries set, block traffic from other geos.
    // Blocked traffic is redirected to geo_fallback_url (should be a smart link)
    // so the traffic is not wasted. Click is NOT recorded on this campaign.
    // Skip geo check if: country is unknown (XX = GeoIP DB missing/lookup failed),
    // or if a valid security_token is provided (preview/test mode — set above).
    const countryUnknown = !country || country === 'XX';
    if (!previewBypass && campaign.allowed_countries) {
      const allowed = campaign.allowed_countries.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
      if (allowed.length > 0 && !countryUnknown && !allowed.includes(country.toUpperCase())) {
        const fallback = campaign.geo_fallback_url;
        if (fallback) {
          // Pass publisher params through so smart link can attribute the redirected click
          const qs = [];
          if (q.pid) qs.push('pid=' + encodeURIComponent(q.pid));
          if (publisher_click_id) qs.push('clickid=' + encodeURIComponent(publisher_click_id));
          if (advertising_id) qs.push('advertising_id=' + encodeURIComponent(advertising_id));
          if (q.sub1) qs.push('sub1=' + encodeURIComponent(q.sub1));
          if (q.sub2) qs.push('sub2=' + encodeURIComponent(q.sub2));
          const dest = fallback + (qs.length ? (fallback.includes('?') ? '&' : '?') + qs.join('&') : '');
          return res.redirect(302, dest);
        }
        // FIX #4: log a rejected click so publisher can debug, still return 200
        db.prepare(`INSERT INTO clicks
          (click_id, campaign_id, publisher_id, user_id, pid, publisher_click_id,
           ip, user_agent, country, device_type, os, platform, advertising_id, status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'geo_blocked')`)
          .run(nanoid16(), campaign.id, publisher_id, campaign.user_id,
               q.pid||null, publisher_click_id, ip, ua, country,
               device_type, os, platform, advertising_id||null);
        return res.status(200).send('GEO_BLOCKED');
      }
    }

    // ── Fraud rule check ──────────────────────────────────────────────────────
    // Evaluate active fraud rules before recording the click.
    {
      const fraudRules = db.prepare(
        "SELECT * FROM fraud_rules WHERE status = 'active'"
      ).all();

      for (const rule of fraudRules) {
        let cfg = {};
        try { cfg = JSON.parse(rule.config || '{}'); } catch {}

        let triggered = false;
        if (rule.rule_type === 'empty_advertising_id') {
          // Block clicks with no advertising ID (often bots / invalid traffic)
          if (!advertising_id) triggered = true;
        } else if (rule.rule_type === 'duplicate_ip_day') {
          // Block same IP converting more than N times per day on same campaign
          const maxHits = cfg.max_hits || 3;
          const ipCount = db.prepare(
            "SELECT COUNT(*) as n FROM clicks WHERE campaign_id = ? AND ip = ? AND date(created_at,'unixepoch')=date('now')"
          ).get(campaign.id, ip)?.n || 0;
          if (ipCount >= maxHits) triggered = true;
        } else if (rule.rule_type === 'blocked_country') {
          const blocked = (cfg.countries || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
          if (blocked.length > 0 && country && blocked.includes(country.toUpperCase())) triggered = true;
        } else if (rule.rule_type === 'datacenter_ip') {
          // Basic ASN/range check — block if IP looks like known cloud provider ranges
          // Simplified: check for common cloud provider IP ranges prefix
          const dcPrefixes = cfg.prefixes || ['3.', '34.', '35.', '52.', '54.', '13.', '18.', '23.', '100.'];
          if (dcPrefixes.some(p => ip.startsWith(p))) triggered = true;
        } else if (rule.rule_type === 'suspicious_cvr') {
          // Block publisher if their conversion rate today is suspiciously high
          if (publisher_id) {
            const minClicks = cfg.min_clicks || 20;
            const maxCvr   = cfg.max_cvr_pct || 80;
            const pubClicks = db.prepare(
              "SELECT COUNT(*) as n FROM clicks WHERE campaign_id=? AND publisher_id=? AND date(created_at,'unixepoch')=date('now')"
            ).get(campaign.id, publisher_id)?.n || 0;
            const pubConvs  = db.prepare(
              "SELECT COUNT(*) as n FROM postbacks WHERE campaign_id=? AND status='attributed' AND date(created_at,'unixepoch')=date('now') AND click_id IN (SELECT click_id FROM clicks WHERE publisher_id=?)"
            ).get(campaign.id, publisher_id)?.n || 0;
            if (pubClicks >= minClicks && pubConvs / pubClicks * 100 >= maxCvr) triggered = true;
          }
        }

        if (triggered) {
          // Increment hit counter
          db.prepare('UPDATE fraud_rules SET hit_count = hit_count + 1, updated_at = unixepoch() WHERE id = ?').run(rule.id);
          // Log the fraud event
          db.prepare(
            "INSERT INTO fraud_log (click_id, campaign_id, user_id, fraud_type, details, action) VALUES (?,?,?,?,?,?)"
          ).run(null, campaign.id, campaign.user_id, rule.rule_type, JSON.stringify({ ip, country, advertising_id, rule_name: rule.name }), rule.action);

          if (rule.action === 'block') {
            const capRedirect = campaign.cap_redirect_url;
            if (capRedirect && /^https?:\/\//i.test(capRedirect)) return res.redirect(302, capRedirect);
            return res.status(200).send('FRAUD_BLOCKED');
          }
          // action === 'flag' → still allow click but mark it
        }
      }
    }

    // ── Cap enforcement ───────────────────────────────────────────────────────
    // Check daily / monthly / total click caps before recording the click.
    // Supports three cap_type modes: 'clicks' (default), 'payout', 'revenue'
    // Per-publisher caps are checked after global caps.
    {
      const capType = campaign.cap_type || 'clicks';
      let capHit = false;

      if (capType === 'clicks') {
        // Original click-count-based caps
        if (campaign.cap_daily > 0 || campaign.cap_monthly > 0 || campaign.cap_total > 0) {
          const todayClicks = campaign.cap_daily > 0
            ? (db.prepare("SELECT COUNT(*) as n FROM clicks WHERE campaign_id = ? AND date(created_at,'unixepoch') = date('now') AND status != 'geo_blocked'").get(campaign.id)?.n || 0)
            : 0;
          const monthClicks = campaign.cap_monthly > 0
            ? (db.prepare("SELECT COUNT(*) as n FROM clicks WHERE campaign_id = ? AND strftime('%Y-%m', created_at,'unixepoch') = strftime('%Y-%m','now') AND status != 'geo_blocked'").get(campaign.id)?.n || 0)
            : 0;
          const totalClicks = campaign.cap_total > 0
            ? (db.prepare("SELECT COUNT(*) as n FROM clicks WHERE campaign_id = ? AND status != 'geo_blocked'").get(campaign.id)?.n || 0)
            : 0;

          capHit = (campaign.cap_daily   > 0 && todayClicks  >= campaign.cap_daily)
                || (campaign.cap_monthly  > 0 && monthClicks  >= campaign.cap_monthly)
                || (campaign.cap_total    > 0 && totalClicks  >= campaign.cap_total);
        }
      } else if (capType === 'payout') {
        // Payout-based caps: check sum of payout sent today / this month
        if (campaign.cap_daily_payout > 0 || campaign.cap_monthly_payout > 0) {
          const todayPayout = campaign.cap_daily_payout > 0
            ? (db.prepare("SELECT COALESCE(SUM(payout),0) as s FROM postbacks WHERE campaign_id = ? AND status='attributed' AND date(created_at,'unixepoch')=date('now')").get(campaign.id)?.s || 0)
            : 0;
          const monthPayout = campaign.cap_monthly_payout > 0
            ? (db.prepare("SELECT COALESCE(SUM(payout),0) as s FROM postbacks WHERE campaign_id = ? AND status='attributed' AND strftime('%Y-%m',created_at,'unixepoch')=strftime('%Y-%m','now')").get(campaign.id)?.s || 0)
            : 0;
          capHit = (campaign.cap_daily_payout   > 0 && todayPayout  >= campaign.cap_daily_payout)
                || (campaign.cap_monthly_payout  > 0 && monthPayout  >= campaign.cap_monthly_payout);
        }
      } else if (capType === 'revenue') {
        // Revenue-based caps: check sum of revenue received
        if (campaign.cap_daily_payout > 0 || campaign.cap_monthly_payout > 0) {
          const todayRev = campaign.cap_daily_payout > 0
            ? (db.prepare("SELECT COALESCE(SUM(revenue),0) as s FROM postbacks WHERE campaign_id = ? AND status='attributed' AND date(created_at,'unixepoch')=date('now')").get(campaign.id)?.s || 0)
            : 0;
          const monthRev = campaign.cap_monthly_payout > 0
            ? (db.prepare("SELECT COALESCE(SUM(revenue),0) as s FROM postbacks WHERE campaign_id = ? AND status='attributed' AND strftime('%Y-%m',created_at,'unixepoch')=strftime('%Y-%m','now')").get(campaign.id)?.s || 0)
            : 0;
          capHit = (campaign.cap_daily_payout   > 0 && todayRev  >= campaign.cap_daily_payout)
                || (campaign.cap_monthly_payout  > 0 && monthRev  >= campaign.cap_monthly_payout);
        }
      }

      if (capHit) {
        const capRedirect = campaign.cap_redirect_url;
        if (capRedirect && /^https?:\/\//i.test(capRedirect)) return res.redirect(302, capRedirect);
        return res.status(200).send('CAP_REACHED');
      }

      // ── Per-publisher cap check ──────────────────────────────────────────────
      if (publisher_id) {
        const pubCap = db.prepare('SELECT * FROM publisher_caps WHERE campaign_id = ? AND publisher_id = ?').get(campaign.id, publisher_id);
        if (pubCap) {
          const pubCapHit =
            (pubCap.cap_daily > 0 && (db.prepare("SELECT COUNT(*) as n FROM clicks WHERE campaign_id=? AND publisher_id=? AND date(created_at,'unixepoch')=date('now')").get(campaign.id, publisher_id)?.n || 0) >= pubCap.cap_daily) ||
            (pubCap.cap_monthly > 0 && (db.prepare("SELECT COUNT(*) as n FROM clicks WHERE campaign_id=? AND publisher_id=? AND strftime('%Y-%m',created_at,'unixepoch')=strftime('%Y-%m','now')").get(campaign.id, publisher_id)?.n || 0) >= pubCap.cap_monthly) ||
            (pubCap.cap_total > 0 && (db.prepare("SELECT COUNT(*) as n FROM clicks WHERE campaign_id=? AND publisher_id=?").get(campaign.id, publisher_id)?.n || 0) >= pubCap.cap_total);

          if (pubCapHit) {
            // Publisher's cap hit — redirect to cap URL if available, else soft block
            const capRedirect = campaign.cap_redirect_url;
            if (capRedirect && /^https?:\/\//i.test(capRedirect)) return res.redirect(302, capRedirect);
            return res.status(200).send('PUBLISHER_CAP_REACHED');
          }
        }
      }
    }

    const click_id = nanoid16();

    // ── Landing page selection (weighted random A/B) ──────────────────────────
    // If the campaign has active landing pages, pick one by weight and use its
    // URL as the destination. The selected landing_page_id is stored on the click.
    let landing_page_id = null;
    {
      const lps = db.prepare(
        "SELECT id, url, weight FROM landing_pages WHERE campaign_id = ? AND status = 'active'"
      ).all(campaign.id);

      if (lps.length > 0) {
        const totalWeight = lps.reduce((s, lp) => s + (lp.weight || 1), 0);
        let rand = Math.random() * totalWeight;
        for (const lp of lps) {
          rand -= (lp.weight || 1);
          if (rand <= 0) {
            landing_page_id = lp.id;
            // Override the destination URL with the landing page URL
            // but preserve existing query params / macros from original destination
            // We still macro-replace the LP URL below
            break;
          }
        }
        // Increment click counter for selected LP
        if (landing_page_id) {
          db.prepare('UPDATE landing_pages SET clicks = clicks + 1 WHERE id = ?').run(landing_page_id);
        }
      }
    }

    db.prepare(`INSERT INTO clicks
      (click_id, campaign_id, publisher_id, user_id,
       pid, af_c_id, af_siteid,
       af_sub1, af_sub2, af_sub3, af_sub4, af_sub5,
       sub6, sub7, sub8, sub9, sub10,
       publisher_click_id, ip, user_agent, country, language,
       device_type, os, browser, advertising_id, platform, referrer,
       creative_id, ad_id, landing_page_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(click_id, campaign.id, publisher_id, campaign.user_id,
           q.pid||null, q.af_c_id||null, q.af_siteid||null,
           q.af_sub1||q.sub1||null, q.af_sub2||q.sub2||null,
           q.af_sub3||q.sub3||null, q.af_sub4||q.sub4||null, q.af_sub5||q.sub5||null,
           q.sub6||null, q.sub7||null, q.sub8||null, q.sub9||null, q.sub10||null,
           publisher_click_id, ip, ua, country, language,
           device_type, os, browser, advertising_id, platform,
           req.headers.referer||null,
           q.creative_id||q.creative||null, q.ad_id||null,
           landing_page_id);

    // Daily stats upsert
    db.prepare(`INSERT INTO daily_stats (user_id, app_id, campaign_id, publisher_id, date, clicks)
      VALUES (?,?,?,?,date('now'),1)
      ON CONFLICT(user_id, app_id, campaign_id, publisher_id, date)
      DO UPDATE SET clicks = clicks + 1`)
      .run(campaign.user_id, campaign.app_id||0, campaign.id, publisher_id||0);

    res.cookie('_cid', click_id, { maxAge: 86400000, httpOnly: true, sameSite: 'Lax' });

    // ── Macro substitution in advertiser's destination/tracking URL ──────────
    // The destination_url may contain the advertiser's own macro placeholders.
    // Fallback chain: landing_page URL → destination_url → preview_url → error
    if (!campaign.destination_url && !campaign.preview_url && !landing_page_id) {
      return res.status(404).send('Campaign has no destination URL configured. Contact your account manager.');
    }

    // If a landing page was selected, use its URL as destination
    let dest;
    if (landing_page_id) {
      const lp = db.prepare('SELECT url FROM landing_pages WHERE id = ?').get(landing_page_id);
      dest = lp?.url || campaign.destination_url || campaign.preview_url;
    } else {
      dest = campaign.destination_url || campaign.preview_url;
    }

    const macroMap = {
      // Our click IDs
      '{click_id}':           click_id,
      '{our_click_id}':       click_id,
      '{transaction_id}':     click_id,   // alias — TUNE/HasOffers use transaction_id as the param name
      // Publisher's own click ID (sent in clickid= param, returned in postbacks)
      '{publisher_click_id}': publisher_click_id || '',
      '{clickid}':            publisher_click_id || '',
      // Publisher / media source tokens
      '{pid}':                q.pid || '',
      '{pub_token}':          q.pid || '',
      '{af_siteid}':          q.af_siteid || '',
      '{site_id}':            q.af_siteid || '',
      // Sub-parameters (both naming conventions)
      '{sub1}':  q.af_sub1 || q.sub1 || '',
      '{sub2}':  q.af_sub2 || q.sub2 || '',
      '{sub3}':  q.af_sub3 || q.sub3 || '',
      '{sub4}':  q.af_sub4 || q.sub4 || '',
      '{sub5}':  q.af_sub5 || q.sub5 || '',
      '{sub6}':  q.sub6 || '',
      '{sub7}':  q.sub7 || '',
      '{sub8}':  q.sub8 || '',
      '{sub9}':  q.sub9 || '',
      '{sub10}': q.sub10 || '',
      '{af_sub1}': q.af_sub1 || q.sub1 || '',
      '{af_sub2}': q.af_sub2 || q.sub2 || '',
      '{af_sub3}': q.af_sub3 || q.sub3 || '',
      '{af_sub4}': q.af_sub4 || q.sub4 || '',
      '{af_sub5}': q.af_sub5 || q.sub5 || '',
      // Device identifiers
      '{advertising_id}': advertising_id || '',
      '{idfa}':           q.idfa || '',
      '{gaid}':           q.gps_adid || q.advertising_id || '',
      '{gps_adid}':       q.gps_adid || '',
      // Geo & device
      '{ip}':          ip,
      '{country}':     country || '',
      '{country_code}':country || '',
      '{device_type}': device_type || '',
      '{os}':          os || '',
      '{browser}':     browser || '',
      '{platform}':    platform || '',
      '{language}':    language || '',
      '{user_agent}':  encodeURIComponent(ua),
      // Campaign identifiers
      '{campaign_id}':    String(campaign.id),
      '{campaign_token}': campaign.campaign_token,
      '{c}':              q.c || campaign.name || '',   // c= query param first (AF standard), fallback to DB name
      '{campaign_name}':  q.c || campaign.name || '',
      '{af_c_id}':        q.af_c_id || String(campaign.id),
      '{creative_id}':    q.creative_id || q.creative || '',
      '{ad_id}':          q.ad_id || '',
      // Adjust-specific click-time macros
      '{adgroup}':        q.adgroup || q.pid || '',
      '{creative}':       q.creative || q.af_sub1 || '',
      '{network}':        q.pid || '',
      '{tracker}':        campaign.campaign_token || '',
      '{label}':          q.label || q.af_sub1 || '',
      '{deeplink}':       q.deeplink || '',
    };

    // Replace every macro in one pass (case-insensitive)
    for (const [macro, value] of Object.entries(macroMap)) {
      dest = dest.split(macro).join(value);
    }

    // If click_id was not embedded in the URL, append it so postbacks can reference it
    if (!dest.includes(click_id)) {
      dest += (dest.includes('?') ? '&' : '?') + 'click_id=' + click_id;
    }

    // FIX #13: only redirect to safe http/https URLs
    if (!/^https?:\/\//i.test(dest)) {
      return res.status(400).send('Invalid destination URL. Contact your account manager.');
    }

    const urlMasking      = !!campaign.url_masking;
    const referrerCloaking = !!campaign.referrer_cloaking;

    // ── Plain redirect (no masking, no referrer stripping) ──────────────────
    if (!urlMasking && !referrerCloaking) {
      return res.redirect(302, dest);
    }

    // ── Referrer cloaking only (strip Referer, no URL masking) ──────────────
    // JS redirect with no-referrer meta: destination never sees our domain as referrer.
    // URL will change in the address bar after JS fires (standard for app store links).
    if (referrerCloaking && !urlMasking) {
      const safeDest = dest.replace(/'/g, '%27');
      return res.send(`<!DOCTYPE html><html><head>
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url='${safeDest}'">
<style>body{margin:0;background:#fff}</style>
</head><body>
<script>try{window.location.replace(${JSON.stringify(dest)})}catch(e){window.location.href=${JSON.stringify(dest)}}</script>
</body></html>`);
    }

    // ── URL masking (+ optional referrer cloaking) ────────────────────────
    // Detect if destination is an app store link — iframes don't work for these.
    // App store links get JS redirect (URL changes but referrer is stripped).
    // Web destinations get iframe (our domain stays in address bar the whole time).
    const isAppStore = /apps\.apple\.com|play\.google\.com|market:\/\/|itms-apps:\/\//i.test(dest);

    if (isAppStore) {
      // App store: can't iframe — fall back to JS redirect with referrer stripped
      const safeDest = dest.replace(/'/g, '%27');
      return res.send(`<!DOCTYPE html><html><head>
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url='${safeDest}'">
<style>body{margin:0;background:#fff}</style>
</head><body>
<script>try{window.location.replace(${JSON.stringify(dest)})}catch(e){window.location.href=${JSON.stringify(dest)}}</script>
</body></html>`);
    }

    // Web destination: iframe keeps our domain in address bar.
    // referrer_cloaking meta tag prevents the iframe from leaking our origin.
    const referrerMeta = referrerCloaking ? '<meta name="referrer" content="no-referrer">' : '';
    return res.send(`<!DOCTYPE html><html><head>
${referrerMeta}
<style>*{margin:0;padding:0;border:0}html,body{width:100%;height:100%;overflow:hidden}
iframe{position:fixed;top:0;left:0;width:100%;height:100%;border:none}</style>
</head><body>
<iframe src=${JSON.stringify(dest)} sandbox="allow-scripts allow-forms allow-same-origin allow-top-navigation allow-popups" allowfullscreen></iframe>
</body></html>`);
  } catch (err) { next(err); }
});

// GET /track/smart/:token  — Smart link: route to best-matching campaign
router.get('/smart/:token', clickLimiter, async (req, res, next) => {
  try {
    const sl = db.prepare(
      "SELECT * FROM smart_links WHERE token = ? AND status = 'active'"
    ).get(req.params.token);

    if (!sl) return res.status(404).send('Smart link not found or inactive');

    const q = req.query;
    const ua = req.headers['user-agent'] || '';
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const country = await lookupCountry(ip);
    const { device_type, os, platform } = parseDevice(ua);

    // Load all rules for this smart link (active campaigns only)
    const rules = db.prepare(`
      SELECT slr.*, c.destination_url, c.campaign_token, c.user_id, c.app_id, c.payout, c.visibility
      FROM smart_link_rules slr
      JOIN campaigns c ON c.id = slr.campaign_id AND c.status = 'active'
      WHERE slr.smart_link_id = ?
      ORDER BY slr.priority ASC, slr.id ASC
    `).all(sl.id);

    // Filter rules that match the request's geo / device / os
    function listMatches(col, val) {
      if (!col) return true;
      const items = col.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      return items.length === 0 || items.includes((val || '').toLowerCase());
    }

    const matching = rules.filter(r =>
      listMatches(r.country_codes, country) &&
      listMatches(r.device_types, device_type) &&
      listMatches(r.os_names, os)
    );

    // Weighted random selection among matching rules
    let selected = null;
    if (matching.length > 0) {
      const totalWeight = matching.reduce((s, r) => s + (r.weight || 1), 0);
      let rand = Math.random() * totalWeight;
      for (const r of matching) {
        rand -= (r.weight || 1);
        if (rand <= 0) { selected = r; break; }
      }
      if (!selected) selected = matching[matching.length - 1];
    }

    // FIX #9: no matching rule → use fallback URL (if none configured, return 200 not login redirect)
    if (!selected) {
      const fallback = sl.fallback_url;
      if (fallback && /^https?:\/\//i.test(fallback)) return res.redirect(302, fallback);
      return res.status(200).send('No matching offer available for your region or device.');
    }

    // Record a click on the selected campaign
    const click_id = nanoid16();
    const publisher_click_id = q.clickid || q.click_id || null;
    const advertising_id = q.advertising_id || q.gps_adid || q.idfa || null;
    const language = req.headers['accept-language']?.split(',')[0] || '';

    let publisher_id = null;
    if (q.pid) {
      const pub = db.prepare('SELECT id FROM publishers WHERE pub_token = ? AND user_id = ?')
        .get(q.pid, selected.user_id);
      if (pub) publisher_id = pub.id;
    }

    db.prepare(`INSERT INTO clicks
      (click_id, campaign_id, publisher_id, user_id,
       pid, publisher_click_id, ip, user_agent, country, language,
       device_type, os, advertising_id, platform, referrer,
       af_sub1, af_sub2, af_sub3, af_sub4, af_sub5,
       smart_link_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(click_id, selected.campaign_id, publisher_id, selected.user_id,
           q.pid||null, publisher_click_id, ip, ua, country, language,
           device_type, os, advertising_id, platform||null, req.headers.referer||null,
           q.sub1||null, q.sub2||null, q.sub3||null, q.sub4||null, q.sub5||null,
           sl.id);

    db.prepare(`INSERT INTO daily_stats (user_id, app_id, campaign_id, publisher_id, date, clicks)
      VALUES (?,?,?,?,date('now'),1)
      ON CONFLICT(user_id, app_id, campaign_id, publisher_id, date)
      DO UPDATE SET clicks = clicks + 1`)
      .run(selected.user_id, selected.app_id||0, selected.campaign_id, publisher_id||0);

    // Build destination URL with macro substitution
    let dest = selected.destination_url || sl.fallback_url || '/';
    const macros = {
      '{click_id}': click_id, '{our_click_id}': click_id,
      '{publisher_click_id}': publisher_click_id || '', '{clickid}': publisher_click_id || '',
      '{pid}': q.pid || '', '{advertising_id}': advertising_id || '',
      '{idfa}': q.idfa || '', '{gaid}': q.gps_adid || '',
      '{ip}': ip, '{country}': country || '', '{country_code}': country || '',
      '{device_type}': device_type || '', '{os}': os || '',
      '{sub1}': q.sub1 || '', '{sub2}': q.sub2 || '', '{sub3}': q.sub3 || '',
      '{sub4}': q.sub4 || '', '{sub5}': q.sub5 || '',
      '{campaign_id}': String(selected.campaign_id), '{campaign_token}': selected.campaign_token,
    };
    for (const [k, v] of Object.entries(macros)) dest = dest.split(k).join(v);
    if (!dest.includes(click_id)) dest += (dest.includes('?') ? '&' : '?') + 'click_id=' + click_id;

    return res.redirect(302, dest);
  } catch (err) { next(err); }
});

// GET /track/imp/:campaign_token  — Impression tracking (1x1 pixel or beacon)
router.get('/imp/:campaign_token', impLimiter, async (req, res, next) => {
  try {
    const { nanoid16: nid } = require('../utils/clickId');
    const campaign = db.prepare(
      "SELECT * FROM campaigns WHERE campaign_token = ? AND status = 'active'"
    ).get(req.params.campaign_token);

    if (campaign) {
      const q = req.query;
      const ua = req.headers['user-agent'] || '';
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const country = await lookupCountry(ip);
      const { device_type, os, platform } = parseDevice(ua);
      const impression_id = nid();

      let publisher_id = null;
      if (q.pid) {
        const pub = db.prepare('SELECT id FROM publishers WHERE pub_token = ? AND user_id = ?')
          .get(q.pid, campaign.user_id);
        if (pub) publisher_id = pub.id;
      }

      db.prepare(`INSERT INTO impressions
        (impression_id, campaign_id, publisher_id, user_id, pid, publisher_click_id,
         ip, user_agent, country, device_type, os, platform, advertising_id,
         af_sub1, af_sub2, af_sub3)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(impression_id, campaign.id, publisher_id, campaign.user_id,
             q.pid||null, q.clickid||q.publisher_click_id||null,
             ip, ua, country, device_type, os, platform,
             q.advertising_id||q.idfa||q.gps_adid||null,
             q.af_sub1||null, q.af_sub2||null, q.af_sub3||null);

      // Upsert impression count into daily_stats
      db.prepare(`INSERT INTO daily_stats (user_id, app_id, campaign_id, publisher_id, date, impressions)
        VALUES (?,?,?,?,date('now'),1)
        ON CONFLICT(user_id, app_id, campaign_id, publisher_id, date)
        DO UPDATE SET impressions = impressions + 1`)
        .run(campaign.user_id, campaign.app_id||0, campaign.id, publisher_id||0);
    }

    // Return 1x1 transparent GIF
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache' });
    res.send(pixel);
  } catch (err) { next(err); }
});

module.exports = router;
