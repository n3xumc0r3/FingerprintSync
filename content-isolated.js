/**
 * FingerprintSync — ISOLATED world content script
 * Runs at document_start. Reads profile + settings from storage and injects
 * the MAIN world script with the profile and settings embedded.
 */

(function FingerprintSyncIsolated() {
  'use strict';

  // Prevent double injection
  const MARKER = '__fpsync_isolated';
  if (document.documentElement.dataset[MARKER]) return;
  document.documentElement.dataset[MARKER] = '1';

  function injectMainScript(profile, settings) {
    const payload = { profile, settings };
    const loader = document.createElement('script');
    loader.textContent = `window.__FINGERPRINT_SYNC_PROFILE = ${JSON.stringify(profile)};` +
      `window.__FINGERPRINT_SYNC_SETTINGS = ${JSON.stringify(settings)};`;
    (document.head || document.documentElement).appendChild(loader);
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content-main.js');
    (document.head || document.documentElement).appendChild(script);
  }

  // Try to get profile and settings from storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([
      'fpsync_profile', 'fpsync_enabled',
      'fpsync_webrtc_block', 'fpsync_local_net_block', 'fpsync_protocol_block',
      'fpsync_link_cleaner', 'fpsync_link_cleaner_aggressive',
      'fpsync_link_cleaner_custom_params', 'fpsync_link_cleaner_custom_prefixes',
    ], (result) => {
      if (!result.fpsync_enabled) return;
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
