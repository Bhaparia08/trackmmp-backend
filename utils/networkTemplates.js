/**
 * Network templates loader for advertiser network presets.
 *
 * Reads backend/data/network-templates.json and exposes:
 *   - loadAll(): returns the full network list
 *   - getByKey(key): returns one preset by key
 *   - render(template, { domain, token }): substitutes {OUR_DOMAIN} and {YOUR_TOKEN}
 *
 * Sprint A (2026-06-11): part of the 3 UX gaps initiative. The templates are
 * source-of-truth for the Network preset dropdown on the Campaign create/edit form.
 */
const path = require('path');
const fs   = require('fs');

const TEMPLATES_PATH = path.join(__dirname, '..', 'data', 'network-templates.json');

let cached = null;
function loadAll() {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(TEMPLATES_PATH, 'utf8');
    cached = JSON.parse(raw);
  } catch (e) {
    console.error('[networkTemplates] failed to load:', e.message);
    cached = { _meta: { version: 0, error: e.message }, networks: [] };
  }
  return cached;
}

function getByKey(key) {
  const all = loadAll();
  return (all.networks || []).find(n => n.key === key) || null;
}

function render(template, { domain, token } = {}) {
  if (!template) return '';
  return String(template)
    .replace(/\{OUR_DOMAIN\}/g, domain || 'track.apogeemobi.com')
    .replace(/\{YOUR_TOKEN\}/g, token || '<your_postback_token>');
}

module.exports = { loadAll, getByKey, render };
