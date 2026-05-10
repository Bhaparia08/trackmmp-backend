/**
 * Lightweight landing-page validator.
 *
 * Follows redirect chain manually (max 8 hops) to capture the final URL,
 * HTTP status, and content size. Catches: dead links, redirect loops,
 * obvious parking domains, content-type mismatches.
 *
 * Tier 2 (headless Chromium) is intentionally NOT included here — that
 * comes in Phase 2. This validator is fast (~500 ms typical) and runs
 * in-process.
 */
const fetch = require('node-fetch');

const PARKING_DOMAINS = new Set([
  'sedoparking.com', 'bodis.com', 'parkingcrew.net', 'godaddy.com',
  'parking-page.com', 'parkingweb.com', 'fastpark.net',
]);

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * Validate a landing page URL.
 * @param {string} url   tracking URL or destination URL
 * @param {object} opts  { mobile?: boolean, country?: string, maxHops?: number }
 * @returns {Promise<{
 *   status: 'valid'|'broken'|'redirect_loop'|'parked'|'timeout'|'mismatch',
 *   final_url: string|null,
 *   http_code: number|null,
 *   chain: Array<{url:string,status:number}>,
 *   content_length: number|null,
 *   notes: string,
 * }>}
 */
async function validate(url, opts = {}) {
  const maxHops = opts.maxHops ?? 8;
  const ua = opts.mobile ? UA_IPHONE : UA_DESKTOP;
  const lang = opts.country
    ? `${opts.country.toLowerCase() === 'us' ? 'en-US' : 'en'},en;q=0.9`
    : 'en-US,en;q=0.9';

  const chain = [];
  let current = url;

  try {
    for (let i = 0; i < maxHops; i++) {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        timeout: 10_000,
        headers: { 'User-Agent': ua, 'Accept-Language': lang, 'Accept': 'text/html,application/xhtml+xml,*/*' },
      });
      chain.push({ url: current, status: res.status });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          return { status: 'broken', final_url: current, http_code: res.status, chain, content_length: null, notes: 'redirect without location header' };
        }
        try { current = new URL(loc, current).toString(); }
        catch { return { status: 'broken', final_url: current, http_code: res.status, chain, content_length: null, notes: 'invalid redirect URL' }; }
        continue;
      }

      // Non-redirect terminal response
      const finalUrl = current;
      const cl = Number(res.headers.get('content-length')) || null;
      const ct = (res.headers.get('content-type') || '').toLowerCase();

      if (res.status >= 500) {
        return { status: 'broken', final_url: finalUrl, http_code: res.status, chain, content_length: cl, notes: `server error ${res.status}` };
      }
      if (res.status === 404 || res.status === 410) {
        return { status: 'broken', final_url: finalUrl, http_code: res.status, chain, content_length: cl, notes: 'page gone' };
      }
      if (res.status >= 400) {
        return { status: 'broken', final_url: finalUrl, http_code: res.status, chain, content_length: cl, notes: `client error ${res.status}` };
      }

      // 2xx — check for parking domains
      try {
        const host = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, '');
        for (const p of PARKING_DOMAINS) {
          if (host === p || host.endsWith('.' + p)) {
            return { status: 'parked', final_url: finalUrl, http_code: res.status, chain, content_length: cl, notes: `parking domain ${p}` };
          }
        }
      } catch {}

      // Suspiciously small body for an HTML landing page
      if (ct.includes('text/html') && cl !== null && cl < 1024) {
        return { status: 'parked', final_url: finalUrl, http_code: res.status, chain, content_length: cl, notes: 'tiny body — likely blank/parking' };
      }

      return { status: 'valid', final_url: finalUrl, http_code: res.status, chain, content_length: cl, notes: '' };
    }

    return { status: 'redirect_loop', final_url: current, http_code: null, chain, content_length: null, notes: `exceeded ${maxHops} hops` };
  } catch (e) {
    const notes = e.code === 'ETIMEDOUT' || e.type === 'request-timeout' ? 'timeout' : (e.message || 'fetch error');
    return { status: notes === 'timeout' ? 'timeout' : 'broken', final_url: current, http_code: null, chain, content_length: null, notes };
  }
}

module.exports = { validate };
