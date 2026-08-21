/**
 * FingerprintSync — ISOLATED world content script
 * Runs at document_start. Reads profile + settings from storage and injects
 * the MAIN world script with the profile and settings embedded via DOM.
 * Sites in the blacklist are skipped entirely — no fingerprint spoofing.
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

  function injectMainScript(profile, settings) {
    const dataEl = document.createElement('div');
    dataEl.id = '__fpsync_data';
    dataEl.style.display = 'none';
    dataEl.setAttribute('data-profile', encodeURIComponent(JSON.stringify(profile)));
    dataEl.setAttribute('data-settings', encodeURIComponent(JSON.stringify(settings)));
    (document.head || document.documentElement).appendChild(dataEl);
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content-main.js');
    (document.head || document.documentElement).appendChild(script);
  }

  function isBlacklisted(hostname, url, blacklist) {
    if (!blacklist || !blacklist.length) return false;
    for (const entry of blacklist) {
      const raw = entry.trim();
      if (!raw) continue;
      // Regex: lines wrapped in /.../ are treated as regex patterns
      if (raw.startsWith('/') && raw.endsWith('/') && raw.length > 2) {
        try {
          const re = new RegExp(raw.slice(1, -1), 'i');
          if (re.test(hostname) || re.test(url)) return true;
        } catch (e) { /* skip invalid regex */ }
        continue;
      }
      // Domain match
      const domain = raw.toLowerCase();
      if (!hostname) continue;
      if (hostname === domain) return true;
      if (domain.startsWith('.') && hostname.endsWith(domain)) return true;
      if (!domain.startsWith('.') && hostname.endsWith('.' + domain)) return true;
    }
    return false;
  }

  // Try to get profile, settings and blacklist from storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([
      'fpsync_profile', 'fpsync_enabled', 'fpsync_blacklist',
      'fpsync_webrtc_block', 'fpsync_local_net_block', 'fpsync_protocol_block',
      'fpsync_link_cleaner', 'fpsync_link_cleaner_aggressive',
      'fpsync_link_cleaner_custom_params', 'fpsync_link_cleaner_custom_prefixes',
    ], (result) => {
      if (!result.fpsync_enabled) return;
      // Blacklist check — skip all spoofing on listed domains
      if (isBlacklisted(hostname, pageUrl, result.fpsync_blacklist)) return;
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
          injectMainScript(profile, settings);
        } catch (e) {
          console.warn('[FingerprintSync] Failed to parse profile', e);
        }
      }
    });
  }

})();
