/**
 * FingerprintSync v2 — Popup Script
 */
'use strict';

const $ = (id) => document.getElementById(id);
let currentSettings = null;
let currentProfile = null;

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
  }
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
}

function updateRegexList(rules) {
  $('regexList').innerHTML = rules.length === 0 ? 'No rules' :
    rules.map((r, i) => `<div style="padding:2px 0;border-bottom:1px solid #0f346022">${i + 1}. <span style="color:#53a8b6">${r}</span></div>`).join('');
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
}
