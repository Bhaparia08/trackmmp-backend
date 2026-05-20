/**
 * Stubs for connectors that aren't implemented yet.
 *
 * Each stub declares its real capabilities (so the UI shows them as "coming
 * soon" rather than hiding them entirely) but returns empty offer lists. They
 * keep the registry complete from day one — no UI changes needed when a real
 * implementation lands.
 */
const { BaseConnector } = require('./base');

class AdjustConnector extends BaseConnector {
  static platform = 'adjust';
  static label = 'Adjust (MMP)';
  static capabilities = {
    list_offers: false,        // Adjust is an MMP — no offer catalog
    get_offer: false, get_creatives: false, get_caps: false,
    get_payouts: false, get_performance: true,
    push_postback: true, webhook_inbound: false,
  };
  static async listOffers(_c) { return []; }
  static normalizeOffer(raw) { return { source_platform: 'adjust', source_offer_id: String(raw.id || ''), name: raw.name || 'Adjust app', raw }; }
}

class BranchConnector extends BaseConnector {
  static platform = 'branch';
  static label = 'Branch (MMP)';
  static capabilities = {
    list_offers: false,
    get_offer: false, get_creatives: false, get_caps: false,
    get_payouts: false, get_performance: true,
    push_postback: true, webhook_inbound: false,
  };
  static async listOffers(_c) { return []; }
  static normalizeOffer(raw) { return { source_platform: 'branch', source_offer_id: String(raw.id || ''), name: raw.name || 'Branch app', raw }; }
}

class CityAdsConnector extends BaseConnector {
  static platform = 'cityads';
  static label = 'CityAds';
  static capabilities = {
    list_offers: true, get_offer: true, get_creatives: true,
    get_caps: true, get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };
  static async listOffers(_c) { return []; }    // TODO: implement
  static normalizeOffer(raw) { return { source_platform: 'cityads', source_offer_id: String(raw.id || ''), name: raw.title || raw.name || 'CityAds offer', raw }; }
}

class RakutenConnector extends BaseConnector {
  static platform = 'rakuten';
  static label = 'Rakuten';
  static capabilities = {
    list_offers: true, get_offer: true, get_creatives: false,
    get_caps: false, get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };
  static async listOffers(_c) { return []; }    // TODO: implement
  static normalizeOffer(raw) { return { source_platform: 'rakuten', source_offer_id: String(raw.advertiser_id || raw.id || ''), name: raw.name || 'Rakuten offer', raw }; }
}

/**
 * Custom connector — used for inbound-webhook and bulk-upload paths.
 * No outbound list_offers; it's push-only from the advertiser side.
 */
class CustomConnector extends BaseConnector {
  static platform = 'custom';
  static label = 'Custom';
  static capabilities = {
    list_offers: false,        // Custom is push-based
    get_offer: false, get_creatives: false, get_caps: false,
    get_payouts: false, get_performance: false,
    push_postback: false, webhook_inbound: true,
  };
  static async listOffers(_c) { return []; }
  static normalizeOffer(raw, _creds) {
    return {
      source_platform: 'custom',
      source_offer_id: String(raw.external_id || raw.id || ''),
      source_advertiser_id: raw.advertiser_id || null,
      name: raw.name,
      description: raw.description || null,
      vertical: raw.vertical || null,
      payout: Number(raw.payout) || 0,
      payout_type: raw.payout_type || 'cpa',
      payout_currency: raw.currency || 'USD',
      allowed_countries: Array.isArray(raw.allowed_countries) ? raw.allowed_countries : [],
      allowed_devices: Array.isArray(raw.allowed_devices) ? raw.allowed_devices : [],
      allowed_os: Array.isArray(raw.allowed_os) ? raw.allowed_os : [],
      destination_url: raw.destination_url || null,
      tracking_url_template: raw.tracking_url_template || null,
      preview_url: raw.preview_url || null,
      caps: raw.caps || {},
      schedule: raw.schedule || {},
      status: raw.status || 'active',
      raw,
    };
  }
}

// ── Affiliate networks — stubs ready for credentials ─────────────────────────
// Each returns empty list until the user provides credentials.  Once a real
// implementation lands (or the network exposes a usable API), swap the body.

class ClickBankConnector extends BaseConnector {
  static platform = 'clickbank';
  static label = 'ClickBank';
  static capabilities = {
    list_offers: false,   // Marketplace data needs scraping or affiliate API
    get_offer: false, get_creatives: false, get_caps: false,
    get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };
  static credentialHints = {
    api_key:    'ClickBank developer key (32-char hex, from CB Account → My Account → Developer)',
    api_secret: 'ClickBank clerk key (8-char from Account → Settings → My Site → Clerk API)',
    network_id: 'Your CB account nickname (lowercase, 5-10 chars)',
  };
  static async listOffers(_c) { return []; }
  static normalizeOffer(raw) {
    return { source_platform:'clickbank', source_offer_id: String(raw.id || raw.sku || ''),
             name: raw.title || raw.name || 'ClickBank offer', raw };
  }
}

class LomadeeConnector extends BaseConnector {
  static platform = 'lomadee';
  static label = 'Lomadee (Brazil)';
  static capabilities = {
    list_offers: false,
    get_offer: false, get_creatives: false, get_caps: false,
    get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };
  static credentialHints = {
    api_key:    'Lomadee app token (from developer.lomadee.com → Apps)',
    api_secret: '(unused)',
    network_id: 'Lomadee source ID (numeric)',
  };
  static async listOffers(_c) { return []; }
  static normalizeOffer(raw) {
    return { source_platform:'lomadee', source_offer_id: String(raw.id || ''),
             name: raw.name || 'Lomadee offer', raw };
  }
}

class ShareASaleConnector extends BaseConnector {
  static platform = 'shareasale';
  static label = 'ShareASale';
  static capabilities = {
    list_offers: false,
    get_offer: false, get_creatives: false, get_caps: false,
    get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };
  static credentialHints = {
    api_key:    'ShareASale token (from Tools → Merchant Tools → API → Tokens)',
    api_secret: 'ShareASale secret key',
    network_id: 'ShareASale affiliate ID (numeric)',
  };
  static async listOffers(_c) { return []; }
  static normalizeOffer(raw) {
    return { source_platform:'shareasale', source_offer_id: String(raw.merchantid || raw.id || ''),
             name: raw.merchantname || raw.name || 'ShareASale merchant', raw };
  }
}

module.exports = {
  AdjustConnector, BranchConnector, CityAdsConnector, RakutenConnector, CustomConnector,
  ClickBankConnector, LomadeeConnector, ShareASaleConnector,
};
