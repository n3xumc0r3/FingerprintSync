/**
 * FingerprintSync — ISOLATED world content script
 * Runs at document_start. Profile delivery only.
 *
 * content-main.js is now registered via chrome.scripting.registerContentScripts
 * in the background service worker (runs in MAIN world at document_start, bypasses CSP).
 *
 * This script's ONLY job: read storage and pass profile data to MAIN world
 * via a hidden DOM element that content-main.js watches for via MutationObserver.
 */

(function FingerprintSyncIsolated() {
  'use strict';

  // Prevent double injection
  const MARKER = '__fpsync_isolated';
  if (document.documentElement.dataset[MARKER]) return;
  document.documentElement.dataset[MARKER] = '1';

  // Extract hostname and full URL for blacklist check
  let hostname = '';
  let pageUrl = '';
  try { hostname = location.hostname.toLowerCase(); pageUrl = location.href; } catch (e) {}

  // Heuristic: detect bare regex (contains regex metacharacters not typical in domains)
  const REGEX_CHARS = /[.*+?^${}()|\[\]]/;
  function looksLikeRegex(s) {
    if (!REGEX_CHARS.test(s)) return false;
    const stripped = s.replace(/\./g, '');
    return REGEX_CHARS.test(stripped);
  }

  function isBlacklisted(hostname, url, blacklist) {
    if (!blacklist || !blacklist.length) return false;
    for (const entry of blacklist) {
      const raw = entry.trim();
      if (!raw) continue;
      // Format 1: /pattern/ or /pattern/flags
      if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
        try {
          const lastSlash = raw.lastIndexOf('/');
          const pattern = raw.slice(1, lastSlash);
          const flags = raw.slice(lastSlash + 1);
          const re = new RegExp(pattern, flags.includes('i') ? flags : flags + 'i');
          if (re.test(hostname) || re.test(url)) return true;
        } catch (e) {}
        continue;
      }
      // Format 2: bare regex like .*google\..*
      if (looksLikeRegex(raw)) {
        try {
          const re = new RegExp(raw, 'i');
          if (re.test(hostname) || re.test(url)) return true;
        } catch (e) {}
        continue;
      }
      // Format 3: plain domain (exact or subdomain)
      const domain = raw.toLowerCase();
      if (!hostname) continue;
      if (hostname === domain) return true;
      if (domain.startsWith('.') && hostname.endsWith(domain)) return true;
      if (!domain.startsWith('.') && hostname.endsWith('.' + domain)) return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // Async read storage and pass data via DOM element.
  // ═══════════════════════════════════════════════════════════════
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([
      'fpsync_profile', 'fpsync_enabled', 'fpsync_blacklist',
      'fpsync_webrtc_block', 'fpsync_local_net_block', 'fpsync_protocol_block',
      'fpsync_link_cleaner', 'fpsync_link_cleaner_aggressive',
      'fpsync_link_cleaner_custom_params', 'fpsync_link_cleaner_custom_prefixes',
    ], (result) => {
      // If disabled or blacklisted, signal "no hooks" so the MAIN script stays clean
      if (!result.fpsync_enabled || isBlacklisted(hostname, pageUrl, result.fpsync_blacklist)) {
        const signal = document.createElement('div');
        signal.id = '__fpsync_data';
        signal.style.display = 'none';
        signal.setAttribute('data-skip', '1');
        (document.head || document.documentElement).appendChild(signal);
        return;
      }
      if (result.fpsync_profile) {
        try {
          const profile = typeof result.fpsync_profile === 'string'
            ? JSON.parse(result.fpsync_profile)
            : result.fpsync_profile;
          const settings = {
            webrtcBlock: result.fpsync_webrtc_block !== false,
            localNetBlock: result.fpsync_local_net_block !== false,
            protocolBlock: result.fpsync_protocol_block !== false,
            linkCleaner: {
              enabled: result.fpsync_link_cleaner !== false,
              aggressive: result.fpsync_link_cleaner_aggressive || false,
              customParams: result.fpsync_link_cleaner_custom_params || '',
              customPrefixes: result.fpsync_link_cleaner_custom_prefixes || '',
            },
          };
          const dataEl = document.createElement('div');
          dataEl.id = '__fpsync_data';
          dataEl.style.display = 'none';
          dataEl.setAttribute('data-profile', encodeURIComponent(JSON.stringify(profile)));
          dataEl.setAttribute('data-settings', encodeURIComponent(JSON.stringify(settings)));
          (document.head || document.documentElement).appendChild(dataEl);
        } catch (e) {
          console.warn('[FingerprintSync] Failed to parse profile', e);
        }
      }
    });
  }

})();
