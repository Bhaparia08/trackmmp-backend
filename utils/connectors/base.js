/**
 * BaseConnector — interface every network connector implements.
 *
 * Each connector declares its capabilities so the orchestrator and UI can
 * gracefully tolerate networks that don't expose every concept (e.g. MMPs
 * have no payouts; some networks have no creatives API).
 *
 * Subclasses MUST override `capabilities` and any methods they support.
 */

class BaseConnector {
  /** @type {string} Unique key — must match the platform value in advertiser_api_credentials.platform */
  static platform = 'base';
  /** @type {string} Human-readable name for the UI */
  static label = 'Base';

  /**
   * Capability declaration. Set true only for what this connector actually does.
   * The UI reads this to hide unsupported columns/actions per row.
   */
  static capabilities = {
    list_offers:     false,
    get_offer:       false,
    get_creatives:   false,
    get_caps:        false,
    get_payouts:     false,
    get_performance: false,
    push_postback:   false,
    webhook_inbound: false,
  };

  /**
   * Probe credentials by calling a cheap endpoint. Returns { ok, error? }.
   * Default: return ok=true (connector that doesn't override is treated as authenticated).
   */
  static async authenticate(_credentials) {
    return { ok: true };
  }

  /**
   * List offers. Returns an array of raw offer objects (network-specific shape).
   * The orchestrator will call `normalizeOffer()` on each one.
   *
   * @param {object} credentials  row from advertiser_api_credentials
   * @param {object} opts         { since?: epochSeconds, status?: 'active'|'paused', page?: number }
   * @returns {Promise<Array<object>>}
   */
  static async listOffers(_credentials, _opts = {}) {
    return [];
  }

  /**
   * Fetch a single offer by external id. Optional — networks without this
   * capability return null and the orchestrator falls back to the last
   * cached payload.
   */
  static async getOffer(_credentials, _externalId) {
    return null;
  }

  /**
   * Convert a raw network-specific offer into the unified NormalizedOffer shape.
   * @returns {NormalizedOffer}
   */
  static normalizeOffer(_rawOffer, _credentials) {
    throw new Error(`${this.platform} connector must implement normalizeOffer()`);
  }
}

/**
 * @typedef {object} NormalizedOffer
 * @property {string} source_platform
 * @property {string} source_offer_id
 * @property {string=} source_advertiser_id
 *
 * @property {string} name
 * @property {string=} description
 * @property {string=} vertical
 * @property {string=} category
 *
 * @property {number=} payout
 * @property {string=} payout_type           cpi|cpa|cpl|cps|cpc|revshare
 * @property {string=} payout_currency
 * @property {number=} revenue
 * @property {string=} revenue_type
 *
 * @property {string[]=} allowed_countries  ISO-3166 alpha-2
 * @property {string[]=} allowed_devices    mobile|tablet|desktop
 * @property {string[]=} allowed_os         android|ios|windows|macos|linux
 * @property {string[]=} allowed_traffic
 *
 * @property {string=} destination_url       landing page URL
 * @property {string=} tracking_url_template tracking URL with {clickid} macros
 * @property {string=} preview_url
 * @property {Array<{type: string, url: string, dimensions?: string}>=} creatives
 *
 * @property {{daily?: number, monthly?: number, total?: number}=} caps
 * @property {{active_from?: number, active_to?: number}=} schedule
 *
 * @property {string=} status                active|paused|pending
 *
 * @property {object} raw                    original payload for debugging
 */

// Phase A: shared approval-status normalizer used by every connector + bridge.
// Maps a platform's per-offer "can the publisher promote this?" signal into
// a single vocabulary: 'approved' | 'pending' | 'rejected' | 'unknown'.
//
// Each connector calls this on its raw field; pass a customMap for any
// platform-specific values that don't fit the defaults.
function normApprovalStatus(value, customMap = {}) {
  if (value == null || value === '') return 'unknown';
  if (value === true)  return 'approved';
  if (value === false) return 'pending';
  const v = String(value).trim().toLowerCase();
  if (customMap[v]) return customMap[v];
  if (['approved', 'active', 'joined', 'connected', 'public'].includes(v)) return 'approved';
  if (['pending', 'application received', 'awaiting approval', 'pendingapproval', 'requires_attention', 'unblocked'].includes(v)) return 'pending';
  if (['rejected', 'declined', 'denied', 'blocked', 'banned'].includes(v)) return 'rejected';
  return 'unknown';
}

module.exports = { BaseConnector, normApprovalStatus };
