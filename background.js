/**
 * FingerprintSync — Background Service Worker
 *
 * Modules:
 *   1. Seed lifecycle (generate, persist, auto-rotate)
 *   2. Profile generation (ProfileEngine + PRNG + DBs)
 *   3. UA header spoofing (declarativeNetRequest)
 *   4. Regex URL Blocker (user-defined regex rules)
 *   5. Local Network blocking (DNR rules)
 *   6. Link Cleaner (auto-clean on navigation)
 *   7. Message handling for popup
 */

'use strict';

importScripts(
  'lib/prng.js',
  'lib/fonts-db.js',
  'lib/gpu-db.js',
  'lib/profile-engine.js',
  'lib/link-cleaner.js'
);

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const STORAGE_KEYS = {
  PROFILE: 'fpsync_profile',
  SEED: 'fpsync_seed',
  SEED_CREATED: 'fpsync_seed_created',
  ENABLED: 'fpsync_enabled',
  SESSION_TTL: 'fpsync_session_ttl',
  // New modules
  REGEX_RULES: 'fpsync_regex_rules',
  LINK_CLEANER_ENABLED: 'fpsync_link_cleaner',
  LINK_CLEANER_MODE: 'fpsync_link_cleaner_mode',
  LINK_CLEANER_AGGRESSIVE: 'fpsync_link_cleaner_aggressive',
  LINK_CLEANER_NEVER_DOMAINS: 'fpsync_link_cleaner_never',
  LINK_CLEANER_ALWAYS_DOMAINS: 'fpsync_link_cleaner_always',
  LINK_CLEANER_CUSTOM_PARAMS: 'fpsync_link_cleaner_custom_params',
  LINK_CLEANER_CUSTOM_PREFIXES: 'fpsync_link_cleaner_custom_prefixes',
  LINK_CLEANER_STATS: 'fpsync_link_cleaner_stats',
  WEBRTC_BLOCK: 'fpsync_webrtc_block',
  LOCAL_NET_BLOCK: 'fpsync_local_net_block',
  PROTOCOL_BLOCK: 'fpsync_protocol_block',
  AUTO_SYNC: 'fpsync_auto_sync',
  SYNCED_IP: 'fpsync_synced_ip',
  BLACKLIST: 'fpsync_blacklist',
};

const DEFAULT_SESSION_TTL = 12;
const ALARM_NAME = 'fpsync-seed-rotation';

// DNR rule ID ranges
const DNR = {
  UA_SPOOF: 1,
  CLIENT_HINTS: 2,
  REGEX_BLOCK_START: 100,   // 100–999
  LOCAL_NET_START: 1000,  // 1000–1099
};

// ═══════════════════════════════════════════════════════════════
// SEED MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function generateSeed() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0];
}

async function getOrCreateSeed() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.SEED,
    STORAGE_KEYS.SEED_CREATED,
    STORAGE_KEYS.SESSION_TTL,
  ]);
  const ttlHours = data[STORAGE_KEYS.SESSION_TTL] || DEFAULT_SESSION_TTL;
  const created = data[STORAGE_KEYS.SEED_CREATED] || 0;
  const now = Date.now();
  const ttlMs = ttlHours * 60 * 60 * 1000;

  if (data[STORAGE_KEYS.SEED] && (now - created) < ttlMs) {
    return data[STORAGE_KEYS.SEED];
  }

  const newSeed = generateSeed();
  await chrome.storage.local.set({
    [STORAGE_KEYS.SEED]: newSeed,
    [STORAGE_KEYS.SEED_CREATED]: now,
  });
  return newSeed;
}

async function forceNewSeed() {
  const newSeed = generateSeed();
  await chrome.storage.local.set({
    [STORAGE_KEYS.SEED]: newSeed,
    [STORAGE_KEYS.SEED_CREATED]: Date.now(),
  });
  return newSeed;
}

// ═══════════════════════════════════════════════════════════════
// PROFILE GENERATION
// ═══════════════════════════════════════════════════════════════
async function generateAndStoreProfile() {
  const seed = await getOrCreateSeed();
  const engine = new ProfileEngine(seed);
  const profile = engine.getProfile();
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: JSON.stringify(profile) });
  await applyAllDNRRulesLocked(profile.ua);
  return profile;
}

// ═══════════════════════════════════════════════════════════════
// DECLARATIVE NET REQUEST — Master rule manager
// ═══════════════════════════════════════════════════════════════
async function applyAllDNRRules(uaString) {
  // Collect all rule IDs we're about to add
  const allRules = [];
  const chromeVer = (uaString.match(/Chrome\/([\d]+)/) || ['','130'])[1];

  // Read blacklist — extract plain domains (not regex) for DNR exclusion
  const blData = await chrome.storage.local.get(STORAGE_KEYS.BLACKLIST);
  const rawBlacklist = blData[STORAGE_KEYS.BLACKLIST] || [];
  const REGEX_CHARS_BG = /[.*+?^${}()|\[\]]/;
  const excludedDomains = rawBlacklist
    .map(e => e.trim())
    .filter(e => {
      if (!e) return false;
      // Skip /pattern/ delimiters
      if (e.startsWith('/') && e.lastIndexOf('/') > 0) return false;
      // Skip bare regex (has metacharacters beyond dots)
      if (REGEX_CHARS_BG.test(e.replace(/\./g, ''))) return false;
      return true;
    })
    .map(e => e.toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  // Remove eTLD+1 duplicates
  const domainSet = [...new Set(excludedDomains)];
  const excludedInitiatorDomains = domainSet.length > 0 ? domainSet : undefined;

  // 1. UA spoofing (ID 1)
  allRules.push({
    id: DNR.UA_SPOOF, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: uaString }] },
    condition: { urlFilter: '*://*/*', resourceTypes: ['main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','csp_report','media','websocket','webtransport','other'], ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },
  });

  // 2. Client Hints (ID 2)
  const platformMatch = uaString.match(/\((Windows|Macintosh|Linux|CrOS|Android|iPhone|iPad)/);
  const chPlatform = platformMatch ? platformMatch[1] === 'Macintosh' ? '"macOS"' : platformMatch[1] === 'CrOS' ? '"ChromeOS"' : `"${platformMatch[1]}"` : '"Windows"';
  allRules.push({
    id: DNR.CLIENT_HINTS, priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Sec-CH-UA', operation: 'set', value: `"Not A(Brand";v="99", "Google Chrome";v="${chromeVer}"` },
        { header: 'Sec-CH-UA-Mobile', operation: 'set', value: '?0' },
        { header: 'Sec-CH-UA-Platform', operation: 'set', value: chPlatform },
      ],
    },
    condition: { urlFilter: '*://*/*', resourceTypes: ['main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','csp_report','media','websocket','webtransport','other'], ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },
  });

  // 3. Regex blocker rules (ID 100+)
  const data = await chrome.storage.local.get(STORAGE_KEYS.REGEX_RULES);
  const regexList = data[STORAGE_KEYS.REGEX_RULES] || [];
  regexList.forEach((regex, i) => {
    allRules.push({
      id: DNR.REGEX_BLOCK_START + i,
      priority: 2,
      action: { type: 'block' },
      condition: { regexFilter: regex, resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest','ping'] },
    });
  });

  // 4. Local network blocking (ID 1000+)
  const settings = await chrome.storage.local.get(STORAGE_KEYS.LOCAL_NET_BLOCK);
  if (settings[STORAGE_KEYS.LOCAL_NET_BLOCK] !== false) {
    const localRanges = [
      '||10.0.0.0/8',
      '||172.16.0.0/12',
      '||192.168.0.0/16',
      '||169.254.0.0/16',
      '||127.0.0.1',
      '||localhost',
      '||0.0.0.0',
    ];
    localRanges.forEach((range, i) => {
      allRules.push({
        id: DNR.LOCAL_NET_START + i,
        priority: 3,
        action: { type: 'block' },
        condition: { urlFilter: range, resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest','ping','image','media','font','stylesheet','other'] },
      });
    });
  }

  // Apply all rules atomically
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingRules.map(r => r.id),
      addRules: allRules,
    });
  } catch (e) {
    console.warn('[FingerprintSync] DNR update failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// LINK CLEANER — Auto-clean on navigation
// ═══════════════════════════════════════════════════════════════
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (!tab.url.startsWith('http')) return;

  const settings = await chrome.storage.local.get([
    STORAGE_KEYS.LINK_CLEANER_ENABLED,
    STORAGE_KEYS.LINK_CLEANER_MODE,
    STORAGE_KEYS.LINK_CLEANER_AGGRESSIVE,
    STORAGE_KEYS.LINK_CLEANER_NEVER_DOMAINS,
    STORAGE_KEYS.LINK_CLEANER_ALWAYS_DOMAINS,
    STORAGE_KEYS.LINK_CLEANER_CUSTOM_PARAMS,
    STORAGE_KEYS.LINK_CLEANER_CUSTOM_PREFIXES,
    STORAGE_KEYS.BLACKLIST,
  ]);

  const enabled = settings[STORAGE_KEYS.LINK_CLEANER_ENABLED] !== false;
  if (!enabled) return;

  // Skip link cleaning on blacklisted domains
  const blacklist = settings[STORAGE_KEYS.BLACKLIST] || [];
  if (blacklist.length > 0) {
    let hostname = '';
    let tabUrl = '';
    try { hostname = new URL(tab.url).hostname.toLowerCase(); tabUrl = tab.url; } catch (e) {}
    const RC = /[.*+?^${}()|\[\]]/;
    for (const entry of blacklist) {
      const raw = entry.trim();
      if (!raw) continue;
      // Regex with delimiters
      if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
        try {
          const ls = raw.lastIndexOf('/');
          const re = new RegExp(raw.slice(1, ls), raw.slice(ls + 1).includes('i') ? raw.slice(ls + 1) : raw.slice(ls + 1) + 'i');
          if (re.test(hostname) || re.test(tabUrl)) return;
        } catch(e) {}
        continue;
      }
      // Bare regex
      if (RC.test(raw.replace(/\./g, ''))) {
        try { if (new RegExp(raw, 'i').test(hostname) || new RegExp(raw, 'i').test(tabUrl)) return; } catch(e) {}
        continue;
      }
      // Plain domain
      const d = raw.toLowerCase();
      if (hostname === d || hostname.endsWith('.' + d)) return;
    }
  }

  const options = {
    aggressive: settings[STORAGE_KEYS.LINK_CLEANER_AGGRESSIVE] || false,
    customParams: (settings[STORAGE_KEYS.LINK_CLEANER_CUSTOM_PARAMS] || '').split('\n').filter(Boolean),
    customPrefixes: (settings[STORAGE_KEYS.LINK_CLEANER_CUSTOM_PREFIXES] || '').split('\n').filter(Boolean),
  };

  const lcSettings = {
    linkCleanerEnabled: enabled,
    linkCleanerMode: settings[STORAGE_KEYS.LINK_CLEANER_MODE] || 'all_except',
    linkCleanerNeverDomains: (settings[STORAGE_KEYS.LINK_CLEANER_NEVER_DOMAINS] || '').split('\n').filter(Boolean),
    linkCleanerAlwaysDomains: (settings[STORAGE_KEYS.LINK_CLEANER_ALWAYS_DOMAINS] || '').split('\n').filter(Boolean),
  };

  if (!shouldAutoClean(tab.url, lcSettings)) return;

  const cleaned = cleanUrl(tab.url, options);
  if (cleaned !== tab.url) {
    try { await chrome.tabs.update(tabId, { url: cleaned }); } catch (e) {}
    // Update stats
    const stats = (await chrome.storage.local.get(STORAGE_KEYS.LINK_CLEANER_STATS))[STORAGE_KEYS.LINK_CLEANER_STATS] || { allTime: 0, session: 0 };
    stats.allTime++;
    stats.session++;
    await chrome.storage.local.set({ [STORAGE_KEYS.LINK_CLEANER_STATS]: stats });
  }
});

// ═══════════════════════════════════════════════════════════════
// ALARMS
// ═══════════════════════════════════════════════════════════════
async function setupAlarm() {
  await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 30, periodInMinutes: 30 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.SEED_CREATED, STORAGE_KEYS.SESSION_TTL, STORAGE_KEYS.ENABLED,
    ]);
    if (!data[STORAGE_KEYS.ENABLED]) return;
    const ttlHours = data[STORAGE_KEYS.SESSION_TTL] || DEFAULT_SESSION_TTL;
    const created = data[STORAGE_KEYS.SEED_CREATED] || 0;
    if (Date.now() - created >= ttlHours * 3600000) {
      await generateAndStoreProfile();
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLING
// ═══════════════════════════════════════════════════════════════
// DNR update lock to prevent concurrent rule conflicts
let _dnrLock = Promise.resolve();
function applyAllDNRRulesLocked(uaString) {
  _dnrLock = _dnrLock.catch(() => {}).then(() => applyAllDNRRules(uaString));
  return _dnrLock;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- Fingerprint profile ---
  if (message.type === 'get_profile') {
    chrome.storage.local.get(STORAGE_KEYS.PROFILE, (data) => {
      try {
        const profile = typeof data[STORAGE_KEYS.PROFILE] === 'string' ? JSON.parse(data[STORAGE_KEYS.PROFILE]) : data[STORAGE_KEYS.PROFILE];
        sendResponse({ success: true, profile });
      } catch (e) { sendResponse({ success: false, error: e.message }); }
    });
    return true;
  }

  if (message.type === 'rotate_seed') {
    (async () => {
      try {
        await forceNewSeed();
        const profile = await generateAndStoreProfile();
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) { try { await chrome.tabs.sendMessage(tab.id, { type: 'profile_updated' }); } catch (e) {} }
        sendResponse({ success: true, profile });
      } catch (e) { sendResponse({ success: false, error: e.message }); }
    })();
    return true;
  }

  if (message.type === 'set_enabled') {
    (async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: message.enabled });
      if (message.enabled) {
        await generateAndStoreProfile();
      } else {
        try {
          const rules = await chrome.declarativeNetRequest.getDynamicRules();
          await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(r => r.id) });
        } catch (e) {}
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'get_settings') {
    chrome.storage.local.get(Object.values(STORAGE_KEYS), (data) => {
      const response = {
        success: true,
        enabled: data[STORAGE_KEYS.ENABLED] !== false,
        seed: data[STORAGE_KEYS.SEED],
        seedCreated: data[STORAGE_KEYS.SEED_CREATED] || 0,
        sessionTTL: data[STORAGE_KEYS.SESSION_TTL] || DEFAULT_SESSION_TTL,
        // Regex blocker
        regexRules: data[STORAGE_KEYS.REGEX_RULES] || [],
        // Link cleaner
        linkCleaner: {
          enabled: data[STORAGE_KEYS.LINK_CLEANER_ENABLED] !== false,
          mode: data[STORAGE_KEYS.LINK_CLEANER_MODE] || 'all_except',
          aggressive: data[STORAGE_KEYS.LINK_CLEANER_AGGRESSIVE] || false,
          neverDomains: data[STORAGE_KEYS.LINK_CLEANER_NEVER_DOMAINS] || '',
          alwaysDomains: data[STORAGE_KEYS.LINK_CLEANER_ALWAYS_DOMAINS] || '',
          customParams: data[STORAGE_KEYS.LINK_CLEANER_CUSTOM_PARAMS] || '',
          customPrefixes: data[STORAGE_KEYS.LINK_CLEANER_CUSTOM_PREFIXES] || '',
          stats: data[STORAGE_KEYS.LINK_CLEANER_STATS] || { allTime: 0, session: 0 },
        },
        // New protections
        webrtcBlock: data[STORAGE_KEYS.WEBRTC_BLOCK] !== false,
        localNetBlock: data[STORAGE_KEYS.LOCAL_NET_BLOCK] !== false,
        protocolBlock: data[STORAGE_KEYS.PROTOCOL_BLOCK] !== false,
        autoSync: data[STORAGE_KEYS.AUTO_SYNC] || false,
        syncedIP: null,
        blacklist: data[STORAGE_KEYS.BLACKLIST] || [],
      };
      // Attach synced IP data
      if (data[STORAGE_KEYS.SYNCED_IP]) {
        try { response.syncedIP = JSON.parse(data[STORAGE_KEYS.SYNCED_IP]); } catch (e) {}
      }
      sendResponse(response);
    });
    return true;
  }

  if (message.type === 'set_ttl') {
    (async () => {
      const ttl = Math.max(1, Math.min(168, message.ttl));
      await chrome.storage.local.set({ [STORAGE_KEYS.SESSION_TTL]: ttl });
      sendResponse({ success: true, ttl });
    })();
    return true;
  }

  // --- Regex blocker ---
  if (message.type === 'set_regex_rules') {
    (async () => {
      const rules = message.rules || [];
      await chrome.storage.local.set({ [STORAGE_KEYS.REGEX_RULES]: rules });
      // Re-apply DNR rules with updated regex
      const profileData = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
      let ua = '';
      try { ua = JSON.parse(profileData[STORAGE_KEYS.PROFILE]).ua; } catch (e) {}
      if (ua) await applyAllDNRRulesLocked(ua);
      sendResponse({ success: true });
    })();
    return true;
  }

  // --- Link cleaner settings ---
  if (message.type === 'set_link_cleaner') {
    (async () => {
      const s = message.settings;
      if (s.enabled !== undefined) await chrome.storage.local.set({ [STORAGE_KEYS.LINK_CLEANER_ENABLED]: s.enabled });
      if (s.mode !== undefined) await chrome.storage.local.set({ [STORAGE_KEYS.LINK_CLEANER_MODE]: s.mode });
      if (s.aggressive !== undefined) await chrome.storage.local.set({ [STORAGE_KEYS.LINK_CLEANER_AGGRESSIVE]: s.aggressive });
      if (s.neverDomains !== undefined) await chrome.storage.local.set({ [STORAGE_KEYS.LINK_CLEANER_NEVER_DOMAINS]: s.neverDomains });
      if (s.alwaysDomains !== undefined) await chrome.storage.local.set({ [STORAGE_KEYS.LINK_CLEANER_ALWAYS_DOMAINS]: s.alwaysDomains });
      if (s.customParams !== undefined) await chrome.storage.local.set({ [STORAGE_KEYS.LINK_CLEANER_CUSTOM_PARAMS]: s.customParams });
      if (s.customPrefixes !== undefined) await chrome.storage.local.set({ [STORAGE_KEYS.LINK_CLEANER_CUSTOM_PREFIXES]: s.customPrefixes });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'reset_link_cleaner_stats') {
    (async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.LINK_CLEANER_STATS]: { allTime: 0, session: 0 } });
      sendResponse({ success: true });
    })();
    return true;
  }

  // --- Toggle protections ---
  if (message.type === 'set_webrtc_block') {
    (async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.WEBRTC_BLOCK]: message.enabled });
      sendResponse({ success: true });
    })();
    return true;
  }
  if (message.type === 'set_local_net_block') {
    (async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.LOCAL_NET_BLOCK]: message.enabled });
      const profileData = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
      let ua = '';
      try { ua = JSON.parse(profileData[STORAGE_KEYS.PROFILE]).ua; } catch (e) {}
      if (ua) await applyAllDNRRulesLocked(ua);
      sendResponse({ success: true });
    })();
    return true;
  }
  if (message.type === 'set_protocol_block') {
    (async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.PROTOCOL_BLOCK]: message.enabled });
      sendResponse({ success: true });
    })();
    return true;
  }

  // --- Sync to IP ---
  if (message.type === 'sync_to_ip') {
    (async () => {
      try {
        const resp = await fetch('http://ip-api.com/json/?fields=status,query,city,country,countryCode,regionName,lat,lon,timezone');
        const ipData = await resp.json();
        if (ipData.status !== 'success') {
          sendResponse({ success: false, error: 'IP lookup failed: ' + (ipData.message || 'unknown') });
          return;
        }
        // Store synced IP info
        await chrome.storage.local.set({ [STORAGE_KEYS.SYNCED_IP]: JSON.stringify(ipData) });
        // Regenerate profile with matched timezone
        const seed = await getOrCreateSeed();
        const engine = new ProfileEngine(seed);
        const profile = engine.getProfile();
        // Override timezone and geo to match real IP
        profile.timezone = ipData.timezone;
        profile.geo = { lat: ipData.lat, lon: ipData.lon, city: ipData.city, country: ipData.country, ip: ipData.query };
        await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: JSON.stringify(profile) });
        await applyAllDNRRulesLocked(profile.ua);
        // Notify all tabs
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) { try { await chrome.tabs.sendMessage(tab.id, { type: 'profile_updated' }); } catch (e) {} }
        sendResponse({ success: true, profile, ip: ipData });
      } catch (e) { sendResponse({ success: false, error: e.message }); }
    })();
    return true;
  }

  // --- Blacklist ---
  if (message.type === 'set_blacklist') {
    (async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.BLACKLIST]: message.domains || [] });
      // Rebuild DNR rules with updated exclusions
      const profileData = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
      let ua = '';
      try { ua = JSON.parse(profileData[STORAGE_KEYS.PROFILE]).ua; } catch (e) {}
      if (ua) await applyAllDNRRulesLocked(ua);
      sendResponse({ success: true });
    })();
    return true;
  }
  if (message.type === 'get_blacklist') {
    chrome.storage.local.get(STORAGE_KEYS.BLACKLIST, (data) => {
      sendResponse({ success: true, domains: data[STORAGE_KEYS.BLACKLIST] || [] });
    });
    return true;
  }

  // --- Toggle auto-sync ---
  if (message.type === 'set_auto_sync') {
    (async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.AUTO_SYNC]: message.enabled });
      sendResponse({ success: true });
    })();
    return true;
  }

  // --- Test link cleaner on current URL ---
  if (message.type === 'test_clean_url') {
    (async () => {
      const settings = await chrome.storage.local.get([
        STORAGE_KEYS.LINK_CLEANER_AGGRESSIVE,
        STORAGE_KEYS.LINK_CLEANER_CUSTOM_PARAMS,
        STORAGE_KEYS.LINK_CLEANER_CUSTOM_PREFIXES,
      ]);
      const options = {
        aggressive: settings[STORAGE_KEYS.LINK_CLEANER_AGGRESSIVE] || false,
        customParams: (settings[STORAGE_KEYS.LINK_CLEANER_CUSTOM_PARAMS] || '').split('\n').filter(Boolean),
        customPrefixes: (settings[STORAGE_KEYS.LINK_CLEANER_CUSTOM_PREFIXES] || '').split('\n').filter(Boolean),
      };
      const cleaned = cleanUrl(message.url, options);
      sendResponse({ success: true, original: message.url, cleaned });
    })();
    return true;
  }
});

// ═══════════════════════════════════════════════════════════════
// IP SYNC — Fetch real IP and match timezone/geo
// ═══════════════════════════════════════════════════════════════
async function syncToIP() {
  try {
    const resp = await fetch('http://ip-api.com/json/?fields=status,query,city,country,countryCode,regionName,lat,lon,timezone');
    const ipData = await resp.json();
    if (ipData.status !== 'success') return;
    await chrome.storage.local.set({ [STORAGE_KEYS.SYNCED_IP]: JSON.stringify(ipData) });
    // Patch existing profile with real timezone + geo
    const data = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
    let profile;
    try { profile = typeof data[STORAGE_KEYS.PROFILE] === 'string' ? JSON.parse(data[STORAGE_KEYS.PROFILE]) : data[STORAGE_KEYS.PROFILE]; } catch (e) { return; }
    if (!profile) return;
    profile.timezone = ipData.timezone;
    profile.geo = { lat: ipData.lat, lon: ipData.lon, city: ipData.city, country: ipData.country, ip: ipData.query };
    await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: JSON.stringify(profile) });
  } catch (e) {
    console.warn('[FingerprintSync] Auto-sync failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: true });
    await generateAndStoreProfile();
  } else if (details.reason === 'update') {
    await generateAndStoreProfile();
  }
  await setupAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await generateAndStoreProfile();
  // Auto-sync IP on browser start
  const data = await chrome.storage.local.get(STORAGE_KEYS.AUTO_SYNC);
  if (data[STORAGE_KEYS.AUTO_SYNC]) {
    await syncToIP();
  }
  await setupAlarm();
});

(async () => {
  const data = await chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.AUTO_SYNC]);
  if (data[STORAGE_KEYS.ENABLED] !== false) {
    await generateAndStoreProfile();
    if (data[STORAGE_KEYS.AUTO_SYNC]) {
      await syncToIP();
    }
  }
  await setupAlarm();
})();
