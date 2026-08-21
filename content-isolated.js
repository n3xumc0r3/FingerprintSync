/**
 * FingerprintSync — ISOLATED world content script
 * Runs at document_start (manifest-declared, guaranteed).
 *
 * content-main.js is injected into MAIN world via
 * chrome.scripting.registerContentScripts (set up in background.js).
 * This script ONLY handles profile delivery via DOM element.
 */

(function FingerprintSyncIsolated() {
  'use strict';

  // Prevent double injection
  const MARKER = '__fpsync_isolated';
  if (document.documentElement.dataset[MARKER]) return;
  document.documentElement.dataset[MARKER] = '1';

  // ─── Profile delivery via DOM element ───
  // content-main.js (MAIN world) watches for __fpsync_data via MutationObserver.
  let hostname = '';
  let pageUrl = '';
  try { hostname = location.hostname.toLowerCase(); pageUrl = location.href; } catch (e) {}

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
      if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
        try {
          const ls = raw.lastIndexOf('/');
          const re = new RegExp(raw.slice(1, ls), raw.slice(ls + 1).includes('i') ? raw.slice(ls + 1) : raw.slice(ls + 1) + 'i');
          if (re.test(hostname) || re.test(url)) return true;
        } catch (e) {}
        continue;
      }
      if (looksLikeRegex(raw)) {
        try {
          const re = new RegExp(raw, 'i');
          if (re.test(hostname) || re.test(url)) return true;
        } catch (e) {}
        continue;
      }
      const domain = raw.toLowerCase();
      if (!hostname) continue;
      if (hostname === domain) return true;
      if (domain.startsWith('.') && hostname.endsWith(domain)) return true;
      if (!domain.startsWith('.') && hostname.endsWith('.' + domain)) return true;
    }
    return false;
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([
      'fpsync_profile', 'fpsync_enabled', 'fpsync_blacklist',
      'fpsync_webrtc_block', 'fpsync_local_net_block', 'fpsync_protocol_block',
      'fpsync_link_cleaner', 'fpsync_link_cleaner_aggressive',
      'fpsync_link_cleaner_custom_params', 'fpsync_link_cleaner_custom_prefixes',
    ], (result) => {
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
