/*!
 * ApogeeMobi Offers SDK v1.0
 * Universal browser-side integration for the ApogeeMobi tracking platform.
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
    apiKey:   attr('data-api-key'),
    apiBase:  attr('data-api-base', defaultBase).replace(/\/$/, ''),
    debug:    sdkScript.hasAttribute('data-debug'),
    cacheTTL: parseInt(attr('data-cache-ttl', '300'), 10) * 1000,
    country:  attr('data-country', ''),
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

  // ─── API call ─────────────────────────────────────────────────────────────
  function fetchOffers(slug, country, limit) {
    var cacheKey = slug + ':' + country + ':' + (limit || '');
    var cached = cacheGet(cacheKey);
    if (cached) { log('cache hit', cacheKey); return Promise.resolve(cached); }

    var url = config.apiBase + '/api/v1/serve?placement_slug=' + encodeURIComponent(slug);
    if (country) url += '&country=' + encodeURIComponent(country);
    if (limit)   url += '&limit='   + encodeURIComponent(limit);

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
    var url   = esc(expandClickId(o.tracking_url));

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
    var url   = esc(expandClickId(o.tracking_url));

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
    var url = esc(expandClickId(o.tracking_url));
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
      var offers = (data && data.offers) || [];
      var type   = (data && data.placement && data.placement.type) || 'comparison_table';

      if (offers.length === 0) {
        el.innerHTML = '<div class="apg-empty">No offers available right now.</div>';
        return;
      }

      if (type === 'comparison_table') {
        el.innerHTML = renderTable(offers, { showRank: showRank });
      } else if (type === 'cta') {
        el.innerHTML = renderCTA(offers[0], customLabel);
      } else {
        el.innerHTML = renderCard(offers[0]);
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
  window.ApogeeMobi.version = '1.0.0';
})();
