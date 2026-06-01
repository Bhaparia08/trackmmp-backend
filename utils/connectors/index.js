/**
 * Connector registry. Resolves platform string → connector class.
 *
 *   const c = registry.get('everflow');
 *   const offers = await c.listOffers(creds);
 *   const norm = c.normalizeOffer(offers[0], creds);
 */
const Everflow   = require('./everflow');
const TUNE       = require('./tune');
const Impact     = require('./impact');
const Insparx    = require('./insparx');
const CJ         = require('./cj');
const MaxBounty  = require('./maxbounty');
const Awin       = require('./awin');
const Trackier    = require('./trackier');
const Affise      = require('./affise');
const ClickDealer = require('./clickdealer');
const CAKE        = require('./cake');
const Ojo7        = require('./ojo7');
const Offer18     = require('./offer18');
const {
  AdjustConnector, BranchConnector, CityAdsConnector, RakutenConnector, CustomConnector,
} = require('./stubs');

// Removed 2026-05-20: clickbank, lomadee, shareasale were stubs that returned []
// and misled operators into thinking we had those integrations. Restore them
// here (along with imports above) when real connectors are built.
const connectors = {
  everflow:   Everflow,
  tune:       TUNE,
  impact:     Impact,
  insparx:    Insparx,
  cj:         CJ,
  maxbounty:  MaxBounty,
  awin:       Awin,
  trackier:    Trackier,
  affise:      Affise,
  clickdealer: ClickDealer,
  cake:        CAKE,
  ojo7:        Ojo7,
  offer18:     Offer18,
  adjust:      AdjustConnector,
  branch:     BranchConnector,
  cityads:    CityAdsConnector,
  rakuten:    RakutenConnector,
  custom:     CustomConnector,
};

function get(platform) {
  return connectors[String(platform || '').toLowerCase()] || null;
}

function list() {
  return Object.values(connectors).map(c => ({
    platform: c.platform,
    label: c.label,
    capabilities: c.capabilities,
    credential_hints: c.credentialHints || null,
  }));
}

module.exports = { get, list, connectors };
