/**
 * FingerprintSync — ISOLATED world content script
 * Runs at document_start. Injects MAIN world script IMMEDIATELY
 * (before any page JS), then passes profile + settings via DOM.
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

  function isBlacklisted(hostname, url, blacklist) {
    if (!blacklist || !blacklist.length) return false;
    for (const entry of blacklist) {
      const raw = entry.trim();
      if (!raw) continue;
      if (raw.startsWith('/') && raw.endsWith('/') && raw.length > 2) {
        try {
          const re = new RegExp(raw.slice(1, -1), 'i');
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

  // STEP 1: Inject MAIN world script IMMEDIATELY at document_start.
  // This runs BEFORE any page JS, so our prototype hooks are installed first.
  // The script will wait for the __fpsync_data element via MutationObserver.
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content-main.js');
  (document.head || document.documentElement).appendChild(script);

  // STEP 2: Async read storage and pass data via DOM element.
  // The MAIN world script picks this up via MutationObserver.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([
      'fpsync_profile', 'fpsync_enabled', 'fpsync_blacklist',
      'fpsync_webrtc_block', 'fpsync_local_net_block', 'fpsync_protocol_block',
      'fpsync_link_cleaner', 'fpsync_link_cleaner_aggressive',
      'fpsync_link_cleaner_custom_params', 'fpsync_link_cleaner_custom_prefixes',
    ], (result) => {
      // If disabled or blacklisted, signal "no profile" so hooks pass through
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
