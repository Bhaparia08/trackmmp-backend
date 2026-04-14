const path = require('path');
const fs = require('fs');
let reader = null;

async function loadReader() {
  if (reader) return reader;
  const dbPath = process.env.GEOIP_DB_PATH || './data/GeoLite2-Country.mmdb';
  if (!fs.existsSync(dbPath)) return null;
  try {
    const maxmind = require('maxmind');
    reader = await maxmind.open(path.resolve(dbPath));
    return reader;
  } catch {
    return null;
  }
}

async function lookupCountry(ip) {
  try {
    const r = await loadReader();
    if (!r) return 'XX';
    const result = r.get(ip);
    return result && result.country ? result.country.iso_code : 'XX';
  } catch {
    return 'XX';
  }
}

module.exports = { lookupCountry };
