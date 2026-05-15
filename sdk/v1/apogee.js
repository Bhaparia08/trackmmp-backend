/*!
 * ApogeeMobi Offers SDK v1.1
 * Universal browser-side integration for the ApogeeMobi tracking platform.
 *
 * v1.1 — adds visitor ID, frequency capping, GDPR/CCPA consent banner,
 *        per-creative A/B testing impression beacon, Prebid header-bid hook.
 *
 * Usage:
 *   <script src="https://track.apogeemobi.com/sdk/v1/apogee.js"
 *           data-api-key="apg_xxxxx" async></script>
 *   <div data-apg-placement="my-slot"></div>
 *
 * Optional attributes on the script tag:
 *   data-api-base    Override the platform URL (default: same origin as the script src)
 *   data-country     Force a country code (default: backend GeoIPs the visitor)
 *   data-debug       Verbose console logging
 *   data-cache-ttl   Cache TTL in seconds (default: 300)
 *
 * Optional attributes on the placement div:
 *   data-apg-limit       Max offers to render (overrides placement default)
 *   data-apg-show-rank   "0" to hide rank column in tables
 *   data-apg-country     Per-placement country override
 *   data-apg-label       Override CTA label for cta-type placements
 *
 * The SDK auto-renders all placements on DOMContentLoaded and on dynamic
 * DOM mutations. Trigger manually: window.ApogeeMobi.render();
 *
 * Click tracking is built into the tracking_url returned by the platform —
 * standard <a href> works without JS interception.
 */
(function () {
  'use strict';

  // ─── Config from <script> tag ────────────────────────────────────────────
  var sdkScript = document.currentScript;
  if (!sdkScript) {
    var scripts = document.querySelectorAll('script[data-api-key]');
    sdkScript = scripts[scripts.length - 1];
  }
  if (!sdkScript) {
    console.warn('[apogee] SDK script tag not found. Add data-api-key.');
    return;
  }

  function attr(name, fallback) {
    return sdkScript.getAttribute(name) || fallback;
  }

  // Derive default API base from the script src so the SDK is self-locating.
  var defaultBase = 'https://track.apogeemobi.com';
  try {
    var src = sdkScript.getAttribute('src');
    if (src) {
      var u = new URL(src, location.href);
      defaultBase = u.origin;
    }
  } catch (e) { /* keep default */ }

  var config = {
    apiKey:        attr('data-api-key'),
    apiBase:       attr('data-api-base', defaultBase).replace(/\/$/, ''),
    debug:         sdkScript.hasAttribute('data-debug'),
    cacheTTL:      parseInt(attr('data-cache-ttl', '300'), 10) * 1000,
    country:       attr('data-country', ''),
    consentMode:   attr('data-consent-mode', 'auto'),   // 'auto' | 'off' | 'always'
    consentText:   attr('data-consent-text', ''),       // override banner copy
    showConsent:   sdkScript.hasAttribute('data-show-consent'), // force banner
    suppressBanner: sdkScript.hasAttribute('data-no-banner'),   // host has its own CMP
  };

  if (!config.apiKey) {
    console.error('[apogee] Missing data-api-key on SDK script tag.');
    return;
  }

  function log() {
    if (!config.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[apogee]');
    console.log.apply(console, args);
  }

  // ─── CSS injection (once) ─────────────────────────────────────────────────
  if (!document.getElementById('apogee-sdk-css')) {
    var css =
      '.apg-table{width:100%;border-collapse:collapse;font-family:inherit;margin:14px 0}' +
      '.apg-table th,.apg-table td{padding:14px 12px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:middle}' +
      '.apg-table th{background:#f9fafb;font-size:11px;text-transform:uppercase;color:#6b7280;letter-spacing:.06em;padding:10px 12px}' +
      '.apg-rank{width:42px;font-weight:700;color:#6366f1;font-size:18px;text-align:center}' +
      '.apg-brand{display:flex;gap:12px;align-items:center}' +
      '.apg-logo{width:54px;height:54px;border-radius:10px;object-fit:contain;background:#fff;border:1px solid #e5e7eb;flex-shrink:0}' +
      '.apg-name{font-weight:700;font-size:15px;color:#111827;line-height:1.25}' +
      '.apg-headline{font-size:13px;color:#374151;margin-top:3px;line-height:1.35}' +
      '.apg-sub{font-size:12px;color:#6b7280;margin-top:2px}' +
      '.apg-payout{font-size:12px;color:#10b981;font-weight:700;display:inline-block;background:rgba(16,185,129,.1);padding:2px 8px;border-radius:10px;margin-top:4px}' +
      '.apg-bonus{font-weight:700;font-size:18px;color:#0f172a;line-height:1.2}' +
      '.apg-bonus-label{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}' +
      '.apg-rating{display:flex;align-items:center;gap:4px;font-size:12px;color:#6b7280;margin-top:4px}' +
      '.apg-stars{color:#f59e0b;letter-spacing:1px;font-size:13px}' +
      '.apg-badge{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:4px;color:#fff;margin-bottom:4px}' +
      '.apg-terms{font-size:10px;color:#9ca3af;margin-top:6px;line-height:1.3}' +
      '.apg-cta{display:inline-block;padding:10px 18px;background:#6366f1;color:#fff!important;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;text-align:center;white-space:nowrap}' +
      '.apg-cta:hover{background:#4f46e5}' +
      '.apg-card{display:flex;gap:16px;padding:18px;border:1px solid #e5e7eb;border-radius:10px;margin:14px 0;align-items:center;background:#fff}' +
      '.apg-card .apg-card-info{flex:1}' +
      '.apg-card .apg-card-bonus{text-align:center;padding:0 12px}' +
      '.apg-empty{padding:14px;color:#6b7280;font-size:13px;font-style:italic;text-align:center;border:1px dashed #e5e7eb;border-radius:6px}' +
      '.apg-loading{padding:14px;color:#9ca3af;font-size:12px;text-align:center}';
    var styleEl = document.createElement('style');
    styleEl.id = 'apogee-sdk-css';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  // ─── localStorage cache (gracefully degrades if disabled) ────────────────
  function cacheGet(key) {
    try {
      var raw = localStorage.getItem('apg:' + key);
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (entry.expires < Date.now()) { localStorage.removeItem('apg:' + key); return null; }
      return entry.value;
    } catch (e) { return null; }
  }
  function cacheSet(key, value, ttlMs) {
    try {
      localStorage.setItem('apg:' + key, JSON.stringify({ value: value, expires: Date.now() + ttlMs }));
    } catch (e) { /* quota or disabled */ }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function genClickId() {
    return 'apg' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  }
  function expandClickId(url) {
    return url.replace('{your_click_id}', genClickId());
  }
  function stars(rating) {
    var r = Math.round(rating);
    return '★'.repeat(r) + '☆'.repeat(Math.max(0, 5 - r));
  }

  // ─── Visitor ID (stable per-browser, used for freq cap + A/B + audit) ────
  function genUid() {
    return 'u_' + Math.random().toString(36).slice(2, 12) +
           Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  }
  function getVisitorId() {
    try {
      var uid = localStorage.getItem('apg:uid');
      if (!uid) {
        uid = genUid();
        localStorage.setItem('apg:uid', uid);
      }
      // Mirror to cookie for non-JS contexts (WP plugin SSR can read it).
      var oneYear = 365 * 24 * 3600;
      document.cookie = 'apg_uid=' + uid + '; max-age=' + oneYear + '; path=/; SameSite=Lax';
      return uid;
    } catch (e) { return ''; }
  }

  // ─── Consent (GDPR/CCPA) ─────────────────────────────────────────────────
  // Three sources, in order of trust:
  //   1) The page already has IAB TCF v2.2 — read __tcfapi().
  //   2) Our own localStorage record from a prior banner Accept/Reject.
  //   3) Default: 'unknown' — banner shown on first eligible page view.
  function readTcfString(cb) {
    if (typeof window.__tcfapi !== 'function') return cb('');
    try {
      window.__tcfapi('getTCData', 2, function (tcData, success) {
        if (success && tcData && tcData.tcString) cb(tcData.tcString);
        else cb('');
      });
    } catch (e) { cb(''); }
  }
  function getStoredConsent() {
    try { return localStorage.getItem('apg:consent') || ''; } catch (e) { return ''; }
  }
  function storeConsent(state) {
    try {
      localStorage.setItem('apg:consent', state);
      localStorage.setItem('apg:consent_at', String(Date.now()));
    } catch (e) {/* quota */}
  }
  function postConsent(state, placementId) {
    if (!state) return;
    var url = config.apiBase + '/api/v1/consent';
    var body = 'consent=' + encodeURIComponent(state) +
               '&uid='     + encodeURIComponent(getVisitorId()) +
               (placementId ? '&placement_id=' + encodeURIComponent(placementId) : '');
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/x-www-form-urlencoded' });
        navigator.sendBeacon(url + '?api_key=' + encodeURIComponent(config.apiKey), blob);
      } else {
        fetch(url + '?api_key=' + encodeURIComponent(config.apiKey), {
          method: 'POST', credentials: 'omit',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body, keepalive: true,
        }).catch(function () {/* swallow */});
      }
    } catch (e) {/* swallow */}
  }

  // Minimal consent banner — inserted lazily, only when the server flags
  // consent_required=true.  Self-removes after Accept or Reject.
  function showConsentBanner(placementId) {
    if (document.getElementById('apg-consent-banner')) return;
    if (config.suppressBanner) return;  // host site has its own CMP
    var msg = config.consentText ||
      'We use cookies and similar tech to personalize offers on this site. You can accept or decline.';
    var el = document.createElement('div');
    el.id = 'apg-consent-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cookie consent');
    el.style.cssText = [
      'position:fixed','left:16px','right:16px','bottom:16px','z-index:2147483600',
      'background:#0f172a','color:#e2e8f0','padding:14px 18px','border-radius:10px',
      'box-shadow:0 12px 40px rgba(0,0,0,.35)','font:14px/1.45 system-ui,sans-serif',
      'display:flex','gap:14px','align-items:center','flex-wrap:wrap',
      'max-width:760px','margin:0 auto'
    ].join(';');
    el.innerHTML =
      '<div style="flex:1;min-width:240px">' + esc(msg) + '</div>' +
      '<button data-apg-consent="rejected" style="background:transparent;color:#e2e8f0;border:1px solid #475569;padding:8px 14px;border-radius:6px;cursor:pointer;font:inherit">Decline</button>' +
      '<button data-apg-consent="accepted" style="background:#6366f1;color:#fff;border:0;padding:8px 16px;border-radius:6px;cursor:pointer;font:inherit;font-weight:600">Accept</button>';
    el.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-apg-consent]');
      if (!btn) return;
      var state = btn.getAttribute('data-apg-consent');
      storeConsent(state);
      postConsent(state, placementId);
      el.remove();
      // Re-render all placeholders so personalized creative fields refresh.
      var els = document.querySelectorAll('[data-apg-placement]');
      for (var i = 0; i < els.length; i++) els[i].removeAttribute('data-apg-rendered');
      detectAndRender();
    });
    (document.body || document.documentElement).appendChild(el);
  }

  // Resolve consent — returns a Promise<string> with current state.
  // Empty string means "not yet decided".
  function resolveConsent() {
    return new Promise(function (resolve) {
      var stored = getStoredConsent();
      if (stored) return resolve(stored);
      readTcfString(function (tc) {
        if (tc) resolve('tcf:' + tc);
        else resolve('');
      });
    });
  }

  // ─── Impression beacon ────────────────────────────────────────────────────
  // Fires once per rendered offer.  Powers freq capping and A/B impressions.
  function reportImpression(o, placement) {
    if (!o || !o.campaign_id || !placement || !placement.id) return;
    var url = config.apiBase + '/api/v1/impression';
    var consent = getStoredConsent();
    var body = [
      'campaign_id=' + encodeURIComponent(o.campaign_id),
      'placement_id=' + encodeURIComponent(placement.id),
      (o.creative && o.creative.creative_id) ? 'creative_id=' + encodeURIComponent(o.creative.creative_id) : '',
      'uid=' + encodeURIComponent(getVisitorId()),
      consent ? 'consent=' + encodeURIComponent(consent) : '',
    ].filter(Boolean).join('&');
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/x-www-form-urlencoded' });
        navigator.sendBeacon(url + '?api_key=' + encodeURIComponent(config.apiKey), blob);
      } else {
        fetch(url + '?api_key=' + encodeURIComponent(config.apiKey), {
          method: 'POST', credentials: 'omit',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body, keepalive: true,
        }).catch(function () {/* swallow */});
      }
    } catch (e) {/* swallow */}
  }

  // ─── Click URL augmentation ───────────────────────────────────────────────
  // The server already includes cv (creative variant) — we add uid + consent
  // so the click row carries the same attribution as the impression.
  function augmentTrackingUrl(rawUrl) {
    var sep = rawUrl.indexOf('?') === -1 ? '?' : '&';
    var consent = getStoredConsent();
    var extra = 'uid=' + encodeURIComponent(getVisitorId());
    if (consent) extra += '&consent=' + encodeURIComponent(consent);
    return rawUrl + sep + extra;
  }

  // ─── API call ─────────────────────────────────────────────────────────────
  function fetchOffers(slug, country, limit) {
    var cacheKey = slug + ':' + country + ':' + (limit || '') + ':' + getStoredConsent();
    var cached = cacheGet(cacheKey);
    if (cached) { log('cache hit', cacheKey); return Promise.resolve(cached); }

    var url = config.apiBase + '/api/v1/serve?placement_slug=' + encodeURIComponent(slug);
    if (country) url += '&country=' + encodeURIComponent(country);
    if (limit)   url += '&limit='   + encodeURIComponent(limit);
    url += '&uid=' + encodeURIComponent(getVisitorId());
    var consent = getStoredConsent();
    if (consent) url += '&consent=' + encodeURIComponent(consent);

    log('fetch', url);
    return fetch(url, {
      headers: { 'x-api-key': config.apiKey, 'accept': 'application/json' },
      credentials: 'omit',
    }).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    }).then(function (data) {
      cacheSet(cacheKey, data, config.cacheTTL);
      return data;
    });
  }

  // ─── Renderers ────────────────────────────────────────────────────────────
  function renderTableRow(o, rank) {
    var cre = o.creative || {};
    var brand = esc(cre.brand_name || o.name);
    var head  = esc(cre.headline || '');
    var sub   = esc(cre.subheadline || o.advertiser_name || '');
    var logo  = cre.logo_url ? '<img class="apg-logo" src="' + esc(cre.logo_url) + '" alt="' + brand + '" loading="lazy" />' : '';
    var badge = cre.badge_text ? '<span class="apg-badge" style="background:#' + esc(cre.badge_color || '6366f1') + '">' + esc(cre.badge_text) + '</span>' : '';
    var rating = (cre.rating != null)
      ? '<div class="apg-rating"><span class="apg-stars">' + stars(cre.rating) + '</span> ' + Number(cre.rating).toFixed(1) +
        (cre.rating_count > 0 ? ' <span style="opacity:.7">(' + Number(cre.rating_count).toLocaleString() + ')</span>' : '') +
        '</div>'
      : '';
    var bonus = cre.bonus_amount
      ? '<div class="apg-bonus">' + esc(cre.bonus_amount) + '</div><div class="apg-bonus-label">' + esc(cre.bonus_label || '') + '</div>'
      : '<div class="apg-payout">$' + Number(o.payout || 0).toFixed(2) + ' ' + esc((o.payout_type || '').toUpperCase()) + '</div>';
    var cta   = esc(cre.cta_text || 'Get Offer');
    var terms = cre.terms_short ? '<div class="apg-terms">' + esc(cre.terms_short) + '</div>' : '';
    var url   = esc(augmentTrackingUrl(expandClickId(o.tracking_url)));

    return '<tr>' +
      '<td class="apg-rank">' + rank + '</td>' +
      '<td><div class="apg-brand">' + logo + '<div>' + badge + '<div class="apg-name">' + brand + '</div>' +
        (head ? '<div class="apg-headline">' + head + '</div>' : '') +
        (sub ? '<div class="apg-sub">' + sub + '</div>' : '') +
        rating + '</div></div></td>' +
      '<td>' + bonus + '</td>' +
      '<td><a class="apg-cta" href="' + url + '" rel="nofollow sponsored noopener" target="_blank">' + cta + '</a>' + terms + '</td>' +
    '</tr>';
  }

  function renderTable(offers, opts) {
    if (offers.length === 0) return '<div class="apg-empty">No offers available right now.</div>';
    var rows = offers.map(function (o, i) { return renderTableRow(o, i + 1); }).join('');
    return '<table class="apg-table">' +
      '<thead><tr>' + (opts.showRank ? '<th>#</th>' : '') + '<th>Brand</th><th>Offer</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
  }

  function renderCard(o) {
    var cre = o.creative || {};
    var brand = esc(cre.brand_name || o.name);
    var head  = esc(cre.headline || '');
    var logo  = cre.logo_url ? '<img class="apg-logo" src="' + esc(cre.logo_url) + '" alt="' + brand + '" loading="lazy" />' : '';
    var badge = cre.badge_text ? '<span class="apg-badge" style="background:#' + esc(cre.badge_color || '6366f1') + '">' + esc(cre.badge_text) + '</span>' : '';
    var rating = (cre.rating != null)
      ? '<div class="apg-rating"><span class="apg-stars">' + stars(cre.rating) + '</span> ' + Number(cre.rating).toFixed(1) + '</div>'
      : '';
    var bonusAmt = esc(cre.bonus_amount || '');
    var bonusLabel = esc(cre.bonus_label || '');
    var terms = cre.terms_short ? '<div class="apg-terms">' + esc(cre.terms_short) + '</div>' : '';
    var cta   = esc(cre.cta_text || 'Get Offer');
    var url   = esc(augmentTrackingUrl(expandClickId(o.tracking_url)));

    return '<div class="apg-card">' +
      logo +
      '<div class="apg-card-info">' + badge +
        '<div class="apg-name">' + brand + '</div>' +
        (head ? '<div class="apg-headline">' + head + '</div>' : '') +
        rating + terms +
      '</div>' +
      (bonusAmt ? '<div class="apg-card-bonus"><div class="apg-bonus">' + bonusAmt + '</div>' +
        (bonusLabel ? '<div class="apg-bonus-label">' + bonusLabel + '</div>' : '') + '</div>' : '') +
      '<a class="apg-cta" href="' + url + '" rel="nofollow sponsored noopener" target="_blank">' + cta + '</a>' +
    '</div>';
  }

  function renderCTA(o, customLabel) {
    var cre = o.creative || {};
    var url = esc(augmentTrackingUrl(expandClickId(o.tracking_url)));
    var label = esc(customLabel || cre.cta_text || 'Get Offer');
    return '<a class="apg-cta" href="' + url + '" rel="nofollow sponsored noopener" target="_blank">' + label + '</a>';
  }

  // ─── Main render loop ─────────────────────────────────────────────────────
  function renderPlacement(el) {
    var slug = el.getAttribute('data-apg-placement');
    if (!slug) return;

    var country = el.getAttribute('data-apg-country') || config.country;
    var limit   = el.getAttribute('data-apg-limit') || '';
    var showRank = el.getAttribute('data-apg-show-rank') !== '0';
    var customLabel = el.getAttribute('data-apg-label');

    el.innerHTML = '<div class="apg-loading">Loading offers…</div>';

    fetchOffers(slug, country, limit).then(function (data) {
      var offers   = (data && data.offers) || [];
      var visitor  = (data && data.visitor) || {};
      var placement = (data && data.placement) || {};
      var type     = placement.type || 'comparison_table';

      // Consent banner — show if backend flagged the visitor's jurisdiction
      // requires it AND we have no stored choice yet AND the host hasn't
      // suppressed via data-no-banner.
      if (visitor.consent_required && !getStoredConsent() && !config.suppressBanner && config.consentMode !== 'off') {
        showConsentBanner(placement.id);
      }

      if (offers.length === 0) {
        el.innerHTML = '<div class="apg-empty">No offers available right now.</div>';
        log('no-offers', slug, 'capped=' + (data.capped_out || []).length);
        return;
      }

      if (type === 'comparison_table') {
        el.innerHTML = renderTable(offers, { showRank: showRank });
      } else if (type === 'cta') {
        el.innerHTML = renderCTA(offers[0], customLabel);
      } else {
        el.innerHTML = renderCard(offers[0]);
      }

      // Impression beacons — one per rendered offer (table shows multiple).
      var rendered = (type === 'comparison_table') ? offers : offers.slice(0, 1);
      rendered.forEach(function (o) { reportImpression(o, placement); });

      // Prebid hook — surface placement floor + config to any host wrapper.
      // The host site (or the demo page) can hook into window.ApogeeMobi
      // to run a Prebid auction in parallel and replace the rendered offer
      // when a higher-eCPM bid wins.
      if (placement.prebid_config) {
        try { window.ApogeeMobi._lastServe = data; } catch (e) {}
        if (typeof window.ApogeeMobi.onServe === 'function') {
          try { window.ApogeeMobi.onServe(data, el); } catch (e) { log('onServe error', e.message); }
        }
      }

      log('rendered', slug, 'count=' + offers.length);
    }).catch(function (err) {
      el.innerHTML = '<div class="apg-empty"></div>';
      log('error', slug, err.message);
    });
  }

  function detectAndRender() {
    var els = document.querySelectorAll('[data-apg-placement]:not([data-apg-rendered])');
    for (var i = 0; i < els.length; i++) {
      els[i].setAttribute('data-apg-rendered', '1');
      renderPlacement(els[i]);
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  log('SDK init', 'base=' + config.apiBase, 'key=' + config.apiKey.slice(0, 8) + '…');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', detectAndRender);
  } else {
    detectAndRender();
  }

  if (window.MutationObserver && document.body) {
    var observer = new MutationObserver(function () { detectAndRender(); });
    function attach() {
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    }
    if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
  }

  window.ApogeeMobi = window.ApogeeMobi || {};
  window.ApogeeMobi.render = detectAndRender;
  window.ApogeeMobi.version = '1.1.0';
  // Consent helpers exposed to host page (custom CMP integrations).
  window.ApogeeMobi.setConsent = function (state) { storeConsent(state); postConsent(state); };
  window.ApogeeMobi.getConsent = getStoredConsent;
  window.ApogeeMobi.getVisitorId = getVisitorId;
})();
