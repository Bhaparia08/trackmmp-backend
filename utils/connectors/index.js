/**
 * Connector registry. Resolves platform string → connector class.
 *
 *   const c = registry.get('everflow');
 *   const offers = await c.listOffers(creds);
 *   const norm = c.normalizeOffer(offers[0], creds);
 */
const Everflow = require('./everflow');
const TUNE     = require('./tune');
const Impact   = require('./impact');
const Insparx  = require('./insparx');
const { AdjustConnector, BranchConnector, CityAdsConnector, RakutenConnector, CustomConnector } = require('./stubs');

const connectors = {
  everflow: Everflow,
  tune:     TUNE,
  impact:   Impact,
  insparx:  Insparx,
  adjust:   AdjustConnector,
  branch:   BranchConnector,
  cityads:  CityAdsConnector,
  rakuten:  RakutenConnector,
  custom:   CustomConnector,
};

function get(platform) {
  return connectors[String(platform || '').toLowerCase()] || null;
}

function list() {
  return Object.values(connectors).map(c => ({
    platform: c.platform,
    label: c.label,
    capabilities: c.capabilities,
  }));
}

module.exports = { get, list, connectors };
