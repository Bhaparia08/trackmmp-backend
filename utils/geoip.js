const path = require('path');
const fs = require('fs');
let reader = null;

async function loadReader() {
  if (reader) return reader;
  // Prefer GeoLite2-City.mmdb if present (provides country + subdivisions + city).
  // Falls back to GeoLite2-Country.mmdb. The reader interface is identical;
  // missing fields just come back undefined.
  const envPath  = process.env.GEOIP_DB_PATH;
  const cityPath = './data/GeoLite2-City.mmdb';
  const ctryPath = './data/GeoLite2-Country.mmdb';
  const candidates = [envPath, cityPath, ctryPath].filter(Boolean);
  const dbPath = candidates.find(p => fs.existsSync(p));
  if (!dbPath) return null;
  try {
    const maxmind = require('maxmind');
    reader = await maxmind.open(path.resolve(dbPath));
    return reader;
  } catch {
    return null;
  }
}

// Returns { country, region, city }.
// - country: ISO 3166-1 alpha-2 (e.g. 'US'); 'XX' if unknown.
// - region:  ISO 3166-2 subdivision code (e.g. 'CA' for California); '' if unknown.
// - city:    English city name; '' if unknown.
// When the loaded DB is country-only, region+city come back empty — callers
// that target on region/city must treat empty as "skip enforcement" (mirrors
// how country handles 'XX').
async function lookupGeo(ip) {
  try {
    const r = await loadReader();
    if (!r) return { country: 'XX', region: '', city: '' };
    const result = r.get(ip) || {};
    return {
      country: result.country?.iso_code || 'XX',
      region:  result.subdivisions?.[0]?.iso_code || '',
      city:    result.city?.names?.en || '',
    };
  } catch {
    return { country: 'XX', region: '', city: '' };
  }
}

// Back-compat wrapper for existing callers.
async function lookupCountry(ip) {
  return (await lookupGeo(ip)).country;
}

module.exports = { lookupCountry, lookupGeo };
