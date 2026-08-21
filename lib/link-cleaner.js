/**
 * Link Cleaner — strip tracking parameters from URLs
 * Core tracking params + aggressive mode extras.
 * Designed to clean the URL in the address bar, not just for copy.
 */

const LINK_CLEANER_CONFIG = {
  // Core tracking parameters (always removed)
  coreParams: [
    // Google Analytics / Ads
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
    'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
    '_ga', '_gl', '_gid', 'gclsrc',
    'gclid', 'gad_source', 'gbraid', 'wbraid',
    // Facebook / Meta
    'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source',
    'fb_ref', 'hrc_enc', 's_cid',
    // Microsoft / Bing
    'msclkid', 'li_fat_id',
    // Twitter / X
    'twclid', 's', 't',
    // LinkedIn
    'li_fat_id', 'trk_contact', 'trk_module', 'trk_sid',
    // Amazon
    'ref', 'ref_', 'tag', 'ascsubtag',
    // Generic trackers
    'mc_eid', 'mc_cid', '_openstat', 'yclid',
    'wickedid', 'dclid', 'spm', 'scm',
    'from', 'source', 'action_object_map', 'action_type_map', 'action_ref_map',
    // HubSpot
    '_hsenc', '_hsmi', 'hsCtaTracking',
    // Vero
    'vero_id', 'vero_conv',
    // Marketo
    'mkt_tok',
    // Yandex
    'yclid', 'ysclid', '_openstat',
    // Mailchimp
    'mc_cid', 'mc_eid',
    // Drip
    '__s', '__hstc', '__hsfp', 'hsCtaTracking',
    // ActiveCampaign
    'vgo_ee', 'vgo_t',
    // Adobe / Omniture
    'ef_id', 's_kwcid',
    // Matomo / Piwik
    'pk_campaign', 'pk_kwd', 'pk_source', 'pk_medium',
    // Hotjar
    'hj_uid', 'hjid', 'hj_lid',
    // Others
    'igshid', 'si', 'feature', 'ref_code',
    'affiliate_id', 'aff_id', 'campaign_id',
    'click_id', 'clickid',
  ],

  // Aggressive mode: additional parameters to strip
  aggressiveParams: [
    'ref', 'referrer', 'referrer_url', 'source_url',
    'campaign', 'ad_id', 'adgroup', 'adset', 'adset_id',
    'creative_id', 'placement', 'placement_id',
    'keyword', 'matchtype', 'network',
    'device', 'devicec', 'devicem',
    'locale', 'lang', 'locale_url',
    'version', 'build', 'variant',
    'tab', 'panel', 'section', 'card',
    'searchlog', 'log', 'debug', 'test', 'mode',
    'token', 'session', 'session_id', 'sessionid',
    'tracking_id', 'visitor_id', 'cookie_id',
    'page_id', 'content_id', 'object_id',
    'impression_id', 'transaction_id',
    'b', 'c', 'd', 'e', 'f',  // single-letter noise params
  ],

  // Parameter prefixes (in aggressive mode)
  aggressivePrefixes: [
    'utm_', 'cm_', 'pk_', 'ef_', 'hj_',
    'hs_', 'mkto_', 'elqTrackId', 'elqTrack',
    'vero_', 'oly_anon_id', 'oly_enc_id',
    '_ga', '_gl', '_hs', '_hss', '_hsci',
    'mc_', 'mkt_',
  ],

  // Domains to never auto-clean
  neverCleanDomains: [
    'google.com', 'youtube.com', 'gmail.com',
    'docs.google.com', 'drive.google.com', 'sheets.google.com',
    'accounts.google.com', 'login.microsoftonline.com',
    'github.com', 'gitlab.com',
    'banking.', 'bank.',
    'localhost', '127.0.0.1',
  ],

  // Domains to always clean (override never-clean)
  alwaysCleanDomains: [],
};

/**
 * Clean a URL by removing tracking parameters.
 * @param {string} url - The URL to clean
 * @param {object} options - { aggressive: bool, customParams: string[], customPrefixes: string[] }
 * @returns {string} - Cleaned URL
 */
function cleanUrl(url, options = {}) {
  try {
    const parsed = new URL(url);
    if (!parsed.search) return url; // No query string to clean

    const aggressive = options.aggressive || false;
    const customParams = options.customParams || [];
    const customPrefixes = options.customPrefixes || [];

    // Build set of params to remove
    const removeSet = new Set(LINK_CLEANER_CONFIG.coreParams);
    if (aggressive) {
      LINK_CLEANER_CONFIG.aggressiveParams.forEach(p => removeSet.add(p));
    }
    customParams.forEach(p => removeSet.add(p.trim()));

    // Build prefix list
    const prefixes = [...LINK_CLEANER_CONFIG.aggressivePrefixes];
    if (aggressive) {
      prefixes.push(...customPrefixes);
    }
    customPrefixes.forEach(p => prefixes.push(p.trim()));

    // Parse and filter params
    const params = parsed.searchParams;
    const toRemove = [];

    for (const [key, value] of params) {
      const lowerKey = key.toLowerCase();

      // Exact match
      if (removeSet.has(key) || removeSet.has(lowerKey)) {
        toRemove.push(key);
        continue;
      }

      // Prefix match (aggressive mode)
      if (aggressive) {
        for (const prefix of prefixes) {
          if (lowerKey.startsWith(prefix.toLowerCase())) {
            toRemove.push(key);
            break;
          }
        }
      }

      // Empty-value params that look like tracking (e.g. ?click_id=)
      if (aggressive && (value === '' || value === undefined)) {
        const noiseNames = ['id', 'ref', 'src', 'cid', 'eid', 'uid', 'tid', 'pid', 'sid'];
        if (noiseNames.includes(lowerKey)) {
          toRemove.push(key);
        }
      }
    }

    // Remove identified params
    for (const key of toRemove) {
      params.delete(key);
    }

    // Reconstruct URL (remove trailing ? if empty)
    let cleaned = parsed.toString();
    if (cleaned.endsWith('?')) {
      cleaned = cleaned.slice(0, -1);
    }

    // Remove trailing & if present
    cleaned = cleaned.replace(/[?&]$/, '');

    return cleaned === url ? url : cleaned;
  } catch (e) {
    return url; // If URL parsing fails, return as-is
  }
}

/**
 * Check if auto-clean should apply to this domain.
 */
function shouldAutoClean(url, settings = {}) {
  const enabled = settings.linkCleanerEnabled;
  const mode = settings.linkCleanerMode; // 'all_except' | 'selected_only' | 'disabled'
  const neverDomains = settings.linkCleanerNeverDomains || LINK_CLEANER_CONFIG.neverCleanDomains;
  const alwaysDomains = settings.linkCleanerAlwaysDomains || LINK_CLEANER_CONFIG.alwaysCleanDomains;

  if (!enabled || mode === 'disabled') return false;

  let hostname;
  try { hostname = new URL(url).hostname; } catch { return false; }

  // Check always-clean first (highest priority)
  for (const d of alwaysDomains) {
    if (hostname === d || hostname.endsWith('.' + d)) return true;
  }

  // Check never-clean
  for (const d of neverDomains) {
    if (hostname === d || hostname.endsWith('.' + d)) return false;
  }

  if (mode === 'all_except') return true;
  if (mode === 'selected_only') return false;

  return false;
}

if (typeof globalThis !== 'undefined') {
  globalThis.LINK_CLEANER_CONFIG = LINK_CLEANER_CONFIG;
  globalThis.cleanUrl = cleanUrl;
  globalThis.shouldAutoClean = shouldAutoClean;
}
