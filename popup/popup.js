/*
 * FingerprintSync v2.1 — Popup Script
 */
'use strict';

const $ = (id) => document.getElementById(id);
let currentSettings = null;
let currentProfile = null;

const TZ_COORDS = {
  'America/New_York':     { lat: 40.71, lng: -74.01 },
  'America/Chicago':      { lat: 41.88, lng: -87.63 },
  'America/Denver':       { lat: 39.74, lng: -104.99 },
  'America/Los_Angeles':  { lat: 34.05, lng: -118.24 },
  'America/Anchorage':    { lat: 61.22, lng: -149.90 },
  'America/Sao_Paulo':    { lat: -23.55, lng: -46.63 },
  'Europe/London':        { lat: 51.51, lng: -0.13 },
  'Europe/Paris':         { lat: 48.86, lng: 2.35 },
  'Europe/Berlin':        { lat: 52.52, lng: 13.41 },
  'Europe/Madrid':        { lat: 40.42, lng: -3.70 },
  'Europe/Rome':          { lat: 41.90, lng: 12.50 },
  'Europe/Amsterdam':     { lat: 52.37, lng: 4.90 },
  'Europe/Moscow':        { lat: 55.76, lng: 37.62 },
  'Europe/Istanbul':      { lat: 41.01, lng: 28.98 },
  'Europe/Warsaw':        { lat: 52.23, lng: 21.01 },
  'Asia/Dubai':           { lat: 25.20, lng: 55.27 },
  'Asia/Kolkata':         { lat: 19.08, lng: 72.88 },
  'Asia/Shanghai':        { lat: 31.23, lng: 121.47 },
  'Asia/Tokyo':           { lat: 35.68, lng: 139.65 },
  'Asia/Seoul':           { lat: 37.57, lng: 126.98 },
  'Asia/Singapore':       { lat: 1.35, lng: 103.82 },
  'Australia/Sydney':     { lat: -33.87, lng: 151.21 },
  'Pacific/Auckland':     { lat: -36.85, lng: 174.76 },
};

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  await loadState();
  setupListeners();
  updateUI();
  startTimer();
});

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $('tab-' + tab.dataset.tab).classList.add('active');
    });
  });
}

function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, resp => resolve(resp || { success: false }));
  });
}

async function loadState() {
  const [settingsResp, profileResp] = await Promise.all([
    sendMessage({ type: 'get_settings' }),
    sendMessage({ type: 'get_profile' }),
  ]);
  currentSettings = settingsResp.success ? settingsResp : { enabled: true, sessionTTL: 12, seed: 0, seedCreated: Date.now() };
  currentProfile = profileResp.success ? profileResp.profile : null;
}

function updateUI() {
  const s = currentSettings;
  const enabled = s?.enabled !== false;
  $('statusTitle').className = enabled ? 'active' : 'inactive';
  $('toggleBtn').textContent = enabled ? 'Enabled' : 'Disabled';
  $('toggleBtn').className = 'toggle-btn' + (enabled ? '' : ' off');
  if (s?.seed) $('seedValue').textContent = '0x' + (s.seed >>> 0).toString(16).padStart(8, '0');
  $('ttlInput').value = s?.sessionTTL || 12;

  if (currentProfile) {
    const osNames = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
    $('profileOS').textContent = osNames[currentProfile.os] || currentProfile.os;
    $('profileUA').textContent = currentProfile.ua?.substring(0, 65) + '...';
    $('profileGPU').textContent = currentProfile.gpu?.unmaskedRenderer || '—';
    $('profileScreen').textContent = `${currentProfile.screen?.width}x${currentProfile.screen?.height} @${currentProfile.screen?.devicePixelRatio}x`;
    $('profileTZ').textContent = currentProfile.timezone || '—';
    $('profileLang').textContent = currentProfile.language || '—';
    $('profileCPU').textContent = `${currentProfile.hardwareConcurrency} cores / ${currentProfile.deviceMemory}GB`;
    $('profileFonts').textContent = `${currentProfile.fonts?.length || 0} fonts`;

    // Geo section
    $('geoTZ').textContent = currentProfile.timezone || '—';
    if (currentProfile.geo) {
      $('geoCoords').textContent = `${currentProfile.geo.lat.toFixed(4)}, ${currentProfile.geo.lon.toFixed(4)}`;
      $('geoCoords').classList.add('synced');
    } else {
      const tzCoords = TZ_COORDS[currentProfile.timezone] || TZ_COORDS['America/New_York'];
      $('geoCoords').textContent = `${tzCoords.lat.toFixed(2)}, ${tzCoords.lng.toFixed(2)} (random)`;
      $('geoCoords').classList.remove('synced');
    }
  }

  // Synced IP display
  if (s?.syncedIP) {
    $('realIP').textContent = s.syncedIP.query || '—';
    $('realIP').classList.add('synced');
    $('ipLocation').textContent = (s.syncedIP.city || '') + ', ' + (s.syncedIP.country || '');
    $('syncStatus').textContent = 'Synced: ' + s.syncedIP.timezone;
    $('syncStatus').style.display = 'block';
  } else {
    $('realIP').textContent = 'not synced';
    $('realIP').classList.remove('synced');
    $('ipLocation').textContent = '—';
    $('syncStatus').style.display = 'none';
  }

  // Auto-sync checkbox
  $('autoSyncCheck').checked = s?.autoSync || false;

  // Network tab
  $('webrtcToggle').checked = s?.webrtcBlock !== false;
  $('localNetToggle').checked = s?.localNetBlock !== false;
  $('protocolToggle').checked = s?.protocolBlock !== false;

  // Link cleaner tab
  const lc = s?.linkCleaner || {};
  $('lcToggle').checked = lc.enabled !== false;
  $('lcAggressive').checked = lc.aggressive || false;
  $('lcCustomParams').value = lc.customParams || '';
  $('lcCustomPrefixes').value = lc.customPrefixes || '';
  $('lcStatsAll').textContent = lc.stats?.allTime || 0;
  $('lcStatsSession').textContent = lc.stats?.session || 0;

  // Regex blocker tab
  $('regexInput').value = (s?.regexRules || []).join('\n');
  updateRegexList(s?.regexRules || []);

  // Blacklist tab
  $('blacklistInput').value = (s?.blacklist || []).join('\n');
  updateBlacklistList(s?.blacklist || []);
}

function updateRegexList(rules) {
  $('regexList').innerHTML = rules.length === 0 ? 'No rules' :
    rules.map((r, i) => `<div style="padding:2px 0;border-bottom:1px solid #0f346022">${i + 1}. <span style="color:#53a8b6">${r}</span></div>`).join('');
}

function updateBlacklistList(domains) {
  $('blacklistList').innerHTML = domains.length === 0 ? 'No exclusions' :
    domains.map((d, i) => `<div style="padding:2px 0;border-bottom:1px solid #0f346022">${i + 1}. <span style="color:#f44336">${d}</span></div>`).join('');
}

function startTimer() {
  updateTimer();
  setInterval(updateTimer, 1000);
}

function updateTimer() {
  if (!currentSettings?.seedCreated || !currentSettings?.sessionTTL) return;
  const elapsed = Date.now() - currentSettings.seedCreated;
  const ttlMs = currentSettings.sessionTTL * 3600000;
  const remaining = Math.max(0, ttlMs - elapsed);
  $('progressFill').style.width = Math.min(100, (elapsed / ttlMs) * 100) + '%';
  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const sec = Math.floor((remaining % 60000) / 1000);
  $('timeRemaining').textContent = `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}

function setupListeners() {
  // Main toggle
  $('toggleBtn').addEventListener('click', async () => {
    const newState = !(currentSettings?.enabled !== false);
    await sendMessage({ type: 'set_enabled', enabled: newState });
    await loadState(); updateUI();
  });

  // Rotate
  $('rotateBtn').addEventListener('click', async () => {
    $('rotateBtn').textContent = 'Rotating...'; $('rotateBtn').disabled = true;
    const resp = await sendMessage({ type: 'rotate_seed' });
    if (resp.success) { currentProfile = resp.profile; await loadState(); updateUI(); }
    $('rotateBtn').textContent = 'Rotate Identity'; $('rotateBtn').disabled = false;
  });

  // Test
  $('testBtn').addEventListener('click', () => chrome.tabs.create({ url: 'https://browserleaks.com' }));

  // TTL
  $('saveTtlBtn').addEventListener('click', async () => {
    const ttl = parseInt($('ttlInput').value, 10);
    if (ttl >= 1 && ttl <= 168) { await sendMessage({ type: 'set_ttl', ttl }); await loadState(); updateUI(); }
  });

  // Sync to IP
  $('syncBtn').addEventListener('click', async () => {
    $('syncBtn').textContent = 'Syncing...'; $('syncBtn').disabled = true;
    const resp = await sendMessage({ type: 'sync_to_ip' });
    if (resp.success) {
      currentProfile = resp.profile;
      await loadState(); updateUI();
      $('syncStatus').textContent = 'Synced: ' + resp.ip.timezone + ' (' + resp.ip.city + ', ' + resp.ip.country + ')';
      $('syncStatus').style.display = 'block';
    } else {
      $('syncStatus').textContent = 'Failed: ' + (resp.error || 'unknown');
      $('syncStatus').style.display = 'block';
      $('syncStatus').style.color = '#f44336';
      setTimeout(() => { $('syncStatus').style.color = '#4caf50'; }, 3000);
    }
    $('syncBtn').textContent = 'Sync to IP'; $('syncBtn').disabled = false;
  });

  // Auto-sync toggle
  $('autoSyncCheck').addEventListener('change', async (e) => {
    await sendMessage({ type: 'set_auto_sync', enabled: e.target.checked });
  });

  // Network toggles
  $('webrtcToggle').addEventListener('change', async (e) => { await sendMessage({ type: 'set_webrtc_block', enabled: e.target.checked }); });
  $('localNetToggle').addEventListener('change', async (e) => { await sendMessage({ type: 'set_local_net_block', enabled: e.target.checked }); });
  $('protocolToggle').addEventListener('change', async (e) => { await sendMessage({ type: 'set_protocol_block', enabled: e.target.checked }); });

  // Link cleaner
  $('lcSaveBtn').addEventListener('click', async () => {
    await sendMessage({ type: 'set_link_cleaner', settings: {
      enabled: $('lcToggle').checked, aggressive: $('lcAggressive').checked,
      customParams: $('lcCustomParams').value, customPrefixes: $('lcCustomPrefixes').value,
    }});
    $('lcSaveBtn').textContent = 'Saved!';
    setTimeout(() => $('lcSaveBtn').textContent = 'Save Settings', 1500);
    await loadState(); updateUI();
  });
  $('lcResetStats').addEventListener('click', async () => {
    await sendMessage({ type: 'reset_link_cleaner_stats' });
    $('lcStatsAll').textContent = '0'; $('lcStatsSession').textContent = '0';
  });

  // Regex blocker
  $('regexSaveBtn').addEventListener('click', async () => {
    const rules = $('regexInput').value.split('\n').filter(l => l.trim());
    await sendMessage({ type: 'set_regex_rules', rules });
    updateRegexList(rules);
    $('regexStatus').textContent = rules.length + ' rules applied';
    setTimeout(() => $('regexStatus').textContent = '', 2000);
  });

  // Blacklist
  $('blacklistSaveBtn').addEventListener('click', async () => {
    const domains = $('blacklistInput').value.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
    await sendMessage({ type: 'set_blacklist', domains });
    updateBlacklistList(domains);
    $('blacklistStatus').textContent = domains.length + ' domains excluded';
    setTimeout(() => $('blacklistStatus').textContent = '', 2000);
  });
}
