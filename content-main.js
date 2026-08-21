/**
 * FingerprintSync — MAIN world content script
 * Injected IMMEDIATELY at document_start (before any page JS).
 * Hooks are installed first, profile data arrives async via DOM MutationObserver.
 *
 * Flow:
 *   1. Install all API hooks immediately (pass-through until profile loads)
 *   2. Wait for __fpsync_data DOM element from ISOLATED world
 *   3. Parse profile, initialize PRNG, hooks start returning spoofed values
 */

'use strict';

(function FingerprintSyncMain() {
  // Prevent double-injection
  const MARKER = '__fpsync_main';
  if (document.documentElement.dataset[MARKER]) return;
  document.documentElement.dataset[MARKER] = '1';
  setTimeout(() => delete document.documentElement.dataset[MARKER], 2000);

  // ─── 1. Profile state — null until data arrives from ISOLATED world ───
  let profile = null;
  let _prngState = 0;
  let fpSettings = { webrtcBlock: true, localNetBlock: true, protocolBlock: true, linkCleaner: { enabled: true, aggressive: false, customParams: '', customPrefixes: '' } };
  let _ready = false;

  function prngNext() {
    let t = (_prngState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function prngInt(min, max) {
    return min + Math.floor(prngNext() * (max - min + 1));
  }

  // ─── Helper: define property safely on prototype chain ───
  function defineProp(obj, prop, value, opts = {}) {
    try {
      const descriptor = {
        configurable: opts.configurable !== undefined ? opts.configurable : false,
        enumerable: opts.enumerable !== undefined ? opts.enumerable : true,
        get: typeof value === 'function' && !opts.valueIsGetter === undefined
          ? value
          : undefined,
        value: typeof value !== 'function' || opts.valueIsGetter ? value : undefined,
        writable: opts.writable !== undefined ? opts.writable : false,
      };
      if (descriptor.get) delete descriptor.value;
      Object.defineProperty(obj, prop, descriptor);
    } catch (e) {}
  }

  function definePropOnChain(proto, prop, getter) {
    let current = proto;
    while (current !== null) {
      try {
        const desc = Object.getOwnPropertyDescriptor(current, prop);
        if (desc && desc.configurable) {
          Object.defineProperty(current, prop, {
            configurable: false,
            enumerable: true,
            get: getter,
          });
          return true;
        }
      } catch (e) {}
      current = Object.getPrototypeOf(current);
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. NAVIGATOR OVERRIDES — installed immediately, use lazy getters
  // ═══════════════════════════════════════════════════════════════
  definePropOnChain(Navigator.prototype, 'userAgent', () => profile ? profile.ua : Navigator.prototype.__lookupGetter__('userAgent').call(navigator));
  definePropOnChain(Navigator.prototype, 'appVersion', () => profile ? profile.appVersion : Navigator.prototype.__lookupGetter__('appVersion').call(navigator));
  definePropOnChain(Navigator.prototype, 'platform', () => profile ? profile.platform : Navigator.prototype.__lookupGetter__('platform').call(navigator));
  definePropOnChain(Navigator.prototype, 'vendor', () => profile ? profile.vendor : Navigator.prototype.__lookupGetter__('vendor').call(navigator));
  definePropOnChain(Navigator.prototype, 'language', () => profile ? profile.language : Navigator.prototype.__lookupGetter__('language').call(navigator));
  definePropOnChain(Navigator.prototype, 'languages', () => profile ? Object.freeze([...profile.languages]) : Navigator.prototype.__lookupGetter__('languages').call(navigator));
  definePropOnChain(Navigator.prototype, 'hardwareConcurrency', () => profile ? profile.hardwareConcurrency : Navigator.prototype.__lookupGetter__('hardwareConcurrency').call(navigator));
  definePropOnChain(Navigator.prototype, 'deviceMemory', () => profile ? profile.deviceMemory : Navigator.prototype.__lookupGetter__('deviceMemory').call(navigator));
  if (typeof Navigator.prototype.__lookupGetter__('doNotTrack') === 'function') {
    definePropOnChain(Navigator.prototype, 'doNotTrack', () => profile && profile.dnt !== undefined ? profile.dnt : Navigator.prototype.__lookupGetter__('doNotTrack').call(navigator));
  }

  // User-Agent Client Hints
  definePropOnChain(Navigator.prototype, 'userAgentData', () => profile ? profile.userAgentData : Navigator.prototype.__lookupGetter__('userAgentData').call(navigator));

  // Navigator.plugins — empty (modern Chrome)
  definePropOnChain(Navigator.prototype, 'plugins', () => {
    const arr = Object.create(PluginArray.prototype);
    Object.defineProperty(arr, 'length', { value: 0, writable: false });
    return arr;
  });
  definePropOnChain(Navigator.prototype, 'mimeTypes', () => {
    const arr = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(arr, 'length', { value: 0, writable: false });
    return arr;
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. SCREEN OVERRIDES — installed immediately
  // ═══════════════════════════════════════════════════════════════
  definePropOnChain(Screen.prototype, 'width', () => profile ? profile.screen.width : screen.width);
  definePropOnChain(Screen.prototype, 'height', () => profile ? profile.screen.height : screen.height);
  definePropOnChain(Screen.prototype, 'availWidth', () => profile ? profile.screen.availWidth : screen.availWidth);
  definePropOnChain(Screen.prototype, 'availHeight', () => profile ? profile.screen.availHeight : screen.availHeight);
  definePropOnChain(Screen.prototype, 'colorDepth', () => profile ? profile.screen.colorDepth : screen.colorDepth);
  definePropOnChain(Screen.prototype, 'pixelDepth', () => profile ? profile.screen.colorDepth : screen.pixelDepth);

  // ═══════════════════════════════════════════════════════════════
  // 4. CANVAS FINGERPRINT — hooks installed immediately
  // ═══════════════════════════════════════════════════════════════
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  function applyCanvasNoise(ctx, canvas) {
    if (!profile) return;
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;
    const imgData = origGetImageData.call(ctx, 0, 0, w, h);
    const data = imgData.data;
    const len = data.length;
    const threshold = 0.03 + prngNext() * 0.02;
    for (let i = 0; i < len; i += 4) {
      if (prngNext() < threshold) {
        const offset = prngNext() > 0.5 ? 1 : -1;
        data[i] = Math.max(0, Math.min(255, data[i] + offset));
        if (prngNext() < 0.3) data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + offset));
        if (prngNext() < 0.2) data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + offset));
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function getOffscreenCopy(canvas) {
    const off = document.createElement('canvas');
    off.width = canvas.width; off.height = canvas.height;
    const octx = off.getContext('2d');
    if (octx) octx.drawImage(canvas, 0, 0);
    return { canvas: off, ctx: octx };
  }

  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    if (!profile) return origToDataURL.apply(this, args);
    const ctx = this.getContext('2d');
    if (ctx) {
      const { canvas: off, ctx: offCtx } = getOffscreenCopy(this);
      if (offCtx) applyCanvasNoise(offCtx, off);
      return origToDataURL.apply(off, args);
    }
    return origToDataURL.apply(this, args);
  };

  HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
    if (!profile) return origToBlob.apply(this, [callback, ...args]);
    const ctx = this.getContext('2d');
    if (ctx) {
      const { canvas: off, ctx: offCtx } = getOffscreenCopy(this);
      if (offCtx) applyCanvasNoise(offCtx, off);
      return origToBlob.apply(off, [callback, ...args]);
    }
    return origToBlob.apply(this, [callback, ...args]);
  };

  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const imgData = origGetImageData.apply(this, args);
    if (!profile) return imgData;
    const data = imgData.data;
    const len = data.length;
    const threshold = 0.03 + prngNext() * 0.02;
    for (let i = 0; i < len; i += 4) {
      if (prngNext() < threshold) {
        const offset = prngNext() > 0.5 ? 1 : -1;
        data[i] = Math.max(0, Math.min(255, data[i] + offset));
      }
    }
    return imgData;
  };

  // ═══════════════════════════════════════════════════════════════
  // 5. WEBGL FINGERPRINT — hooks installed immediately
  // ═══════════════════════════════════════════════════════════════
  function hookWebGLGetParameter(gpu) {
    return function(pname) {
      if (!profile) return this.__origGetParam.call(this, pname);
      switch (pname) {
        case 0x1F01: return gpu.renderer;
        case 0x1F00: return gpu.vendor;
        case 0x9245: return gpu.unmaskedVendor || gpu.vendor;
        case 0x9246: return gpu.unmaskedRenderer || gpu.renderer;
        case 0x0D33: return gpu.maxTextureSize;
        case 0x0D3A: return gpu.maxRenderBufferSize;
        case 0x0D32: return gpu.maxCubeMapSize;
        case 0x0D50: return new Float32Array(gpu.pointSizeRange);
        case 0x0D3A: return new Int32Array(gpu.maxViewportDims);
        default: return this.__origGetParam.call(this, pname);
      }
    };
  }

  function hookGetExtension(gpu) {
    return function(name) {
      const ext = this.__origGetExt.call(this, name);
      if (!ext) return ext;
      if (name === 'WEBGL_debug_renderer_info') {
        return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
      }
      return ext;
    };
  }

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    const ctx = origGetContext.call(this, type, ...args);
    if (!ctx) return ctx;
    if (!profile) return ctx;
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      const gpu = profile.gpu;
      const origGetParam = ctx.getParameter.bind(ctx);
      ctx.__origGetParam = origGetParam;
      ctx.getParameter = hookWebGLGetParameter(gpu);
      const origGetExt = ctx.getExtension.bind(ctx);
      ctx.__origGetExt = origGetExt;
      ctx.getExtension = hookGetExtension(gpu);
      ctx.getSupportedExtensions = () => gpu.extensions;
      origGetExt('WEBGL_debug_renderer_info');
    }
    return ctx;
  };

  // ═══════════════════════════════════════════════════════════════
  // 6. AUDIO FINGERPRINT — hook installed immediately
  // ═══════════════════════════════════════════════════════════════
  const origGetChannelData = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = function(channel) {
    const data = origGetChannelData.call(this, channel);
    if (!profile) return data;
    for (let i = 0; i < data.length; i += 100) {
      data[i] += (prngNext() - 0.5) * 0.0001;
    }
    return data;
  };

  // ═══════════════════════════════════════════════════════════════
  // 7. FONT FINGERPRINT — hook installed immediately
  // ═══════════════════════════════════════════════════════════════
  if (document.fonts && document.fonts.check) {
    const origCheck = document.fonts.check.bind(document.fonts);
    document.fonts.check = function(font, text) {
      if (!profile) return origCheck(font, text);
      const name = (font.match(/"?([^","]+)"?/) || [])[1];
      if (name && profile.fonts && !profile.fonts.includes(name)) return false;
      return origCheck(font, text);
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 8. CLIENTRECTS NOISE — hook installed immediately
  // ═══════════════════════════════════════════════════════════════
  const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function() {
    const rect = origGetBoundingClientRect.call(this);
    if (!profile) return rect;
    const noise = (prngNext() - 0.5) * 0.5;
    return new DOMRect(rect.x + noise, rect.y + noise, rect.width, rect.height);
  };

  // ═══════════════════════════════════════════════════════════════
  // 9. WEBGPU — hook installed immediately
  // ═══════════════════════════════════════════════════════════════
  if (navigator.gpu) {
    const origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async function(...args) {
      if (args[0] && typeof args[0] === 'object' && 'powerPreference' in args[0]) {
        const { powerPreference, ...rest } = args[0];
        args[0] = rest;
      }
      const adapter = await origRequestAdapter(...args);
      if (!profile || !adapter) return adapter;
      const webgpu = profile.webgpu;
      const gpu = profile.gpu;
      return new Proxy(adapter, {
        get(target, prop) {
          if (prop === 'info') {
            return {
              vendor: webgpu.vendor,
              architecture: webgpu.architecture,
              device: webgpu.device,
              description: webgpu.description,
              features: new Set(webgpu.features || []),
              limits: { maxTextureDimension1D: gpu.maxTextureSize, maxTextureDimension2D: gpu.maxTextureSize, maxTextureArrayLayers: 256, maxBindGroups: 4 },
            };
          }
          const val = target[prop];
          if (typeof val === 'function') return val.bind(target);
          return val;
        },
      });
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 10. TIMEZONE — deferred to when profile is ready
  // ═══════════════════════════════════════════════════════════════
  function applyTimezone() {
    if (!profile) return;
    try {
      const origDateTimeFormat = Intl.DateTimeFormat;
      Intl.DateTimeFormat = function(...args) {
        if (args.length === 0 || (args.length === 1 && typeof args[0] === 'string' && !args[0].includes('/'))) {
          args[0] = profile.timezone;
        }
        return new origDateTimeFormat(...args);
      };
      const origSV = Intl.DateTimeFormat.supportedValuesOf;
      Object.defineProperty(Intl.DateTimeFormat, 'supportedValuesOf', {
        configurable: true,
        value: function(key) {
          if (key === 'timeZone') {
            const all = origSV.call(this, key);
            if (!all.includes(profile.timezone)) return [...all, profile.timezone];
            return all;
          }
          return origSV.call(this, key);
        },
      });
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════
  // 11. GEOLOCATION — deferred
  // ═════════════════════════════════════════════════════════════
  function applyGeolocation() {
    if (!profile) return;
    const TZ_COORDS = {
      'America/New_York': { lat: 40.7128, lng: -74.006 }, 'America/Chicago': { lat: 41.8781, lng: -87.6298 },
      'America/Denver': { lat: 39.7392, lng: -104.9903 }, 'America/Los_Angeles': { lat: 34.0522, lng: -118.2437 },
      'Europe/London': { lat: 51.5074, lng: -0.1278 }, 'Europe/Paris': { lat: 48.8566, lng: 2.3522 },
      'Europe/Berlin': { lat: 52.52, lng: 13.405 }, 'Europe/Moscow': { lat: 55.7558, lng: 37.6173 },
      'Asia/Tokyo': { lat: 35.6762, lng: 139.65 }, 'Asia/Shanghai': { lat: 31.2304, lng: 121.4737 },
      'Australia/Sydney': { lat: -33.8688, lng: 151.2093 },
    };
    const gc = TZ_COORDS[profile.timezone] || TZ_COORDS['America/New_York'];
    const makePos = () => ({
      coords: { latitude: gc.lat + (prngNext() - 0.5) * 0.05, longitude: gc.lng + (prngNext() - 0.5) * 0.05, accuracy: 50 + prngInt(0, 100), altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now(),
    });
    const origGP = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    const origWP = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = function(s, e, o) { if (s) setTimeout(() => s(makePos()), 50 + prngInt(0, 100)); };
    navigator.geolocation.watchPosition = function(s, e, o) { if (s) { const id = setInterval(() => s(makePos()), 5000); return prngInt(1, 99999); } return prngInt(1, 99999); };
  }

  // ═══════════════════════════════════════════════════════════════
  // 12. MATCH MEDIA / PREFERENCES
  // ═════════════════════════════════════════════════════════════
  const origMatchMedia = window.matchMedia;
  window.matchMedia = function(q) {
    const r = origMatchMedia.call(this, q);
    if (!profile) return r;
    if (q === '(prefers-color-scheme: dark)') return { ...r, matches: prngNext() < 0.45 };
    if (q === '(prefers-reduced-motion: reduce)') return { ...r, matches: false };
    return r;
  };

  // ═══════════════════════════════════════════════════════════════
  // 13. GLOBAL PRIVACY CONTROL
  // ═══════════════════════════════════════════════════════════════
  function applyGPC() {
    if (!profile || !profile.gpc) return;
    try { Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, enumerable: true, get: () => true }); } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════
  // 14. PERFORMANCE TIMING LEAK REDUCTION
  // ═══════════════════════════════════════════════════════════════
  try {
    const origNow = performance.now.bind(performance);
    const PRECISION = 0.1;
    Object.defineProperty(performance, 'now', { configurable: true, value: function() { return Math.floor(origNow() / PRECISION) * PRECISION; } });
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════
  // 15. WEBRTC IP LEAK PROTECTION — hook installed immediately
  // ═══════════════════════════════════════════════════════════════
  if (window.RTCPeerConnection) {
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = function(config, constraints) {
      // Strip ALL ICE/STUN/TURN servers to prevent any IP discovery
      const safeConfig = { ...(config || {}), iceServers: [] };
      const instance = new OrigRTC(safeConfig, constraints);
      if (!fpSettings.webrtcBlock) return instance;
      const origCreateOffer = instance.createOffer.bind(instance);
      instance.createOffer = async function(o) { const offer = await origCreateOffer(o || {}); if (offer.sdp) offer.sdp = offer.sdp.replace(/a=candidate:.+\r?\n/g, ''); return offer; };
      const origSetLocalDesc = instance.setLocalDescription.bind(instance);
      instance.setLocalDescription = async function(d) { if (d && d.sdp) d.sdp = d.sdp.replace(/a=candidate:.+\r?\n/g, ''); return origSetLocalDesc(d); };
      Object.defineProperty(instance, 'onicecandidate', { configurable: true, get() { return null; }, set() {} });
      Object.defineProperty(instance, 'iceGatheringState', { configurable: true, get: () => 'new' });
      try {
        const origLD = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription');
        if (origLD && origLD.get) {
          Object.defineProperty(instance, 'localDescription', { configurable: true, get: () => { const d = origLD.get.call(instance); if (d && d.sdp) return { type: d.type, sdp: d.sdp.replace(/a=candidate:.+\r?\n/g, '') }; return d; } });
        }
      } catch (e) {}
      const origGetStats = instance.getStats.bind(instance);
      instance.getStats = async function() { const s = await origGetStats(); if (s instanceof Map) { const c = new Map(); for (const [k, v] of s) { if (v && (v.type === 'local-candidate' || (v.type === 'candidate-pair' && v.localCandidateId))) continue; c.set(k, v); } return c; } return s; };
      return instance;
    };
    window.RTCPeerConnection.prototype = OrigRTC.prototype;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = window.RTCPeerConnection;
  }

  // ═══════════════════════════════════════════════════════════════
  // 16. CUSTOM PROTOCOL SCHEME PROTECTION
  // ═══════════════════════════════════════════════════════════════
  const BLOCKED_PROTOCOLS = new Set([
    'slack','zoom','teams','skype','discord','spotify','telegram','whatsapp','viber',
    'outlook','steam','epicgames','riotclient','magnet','torrent','thunder',
    'vscode','cursor','intellij','xcode','figma','notion','obsidian',
    '1password','bitwarden','keepassxc','deezer','tidal','zoommtg','msteams',
    'sip','sips','facetime','chrome-extension','moz-extension','brave',
  ]);
  const ALLOWED_PROTOCOLS = new Set(['http','https','about','javascript','data','blob','ftp','file']);
  const isCustomProtocol = (url) => { try { const m = String(url).match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/); return m && !ALLOWED_PROTOCOLS.has(m[1].toLowerCase()); } catch { return false; } };
  const origWindowOpen = window.open;
  window.open = function(url, target, features) {
    if (typeof url === 'string' && isCustomProtocol(url)) { const m = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/); if (m && BLOCKED_PROTOCOLS.has(m[1].toLowerCase())) return null; }
    return origWindowOpen.call(this, url, target, features);
  };

  // ═══════════════════════════════════════════════════════════════
  // 17. LOCAL NETWORK PROBING PROTECTION
  // ═══════════════════════════════════════════════════════════════
  const isLocalIP = (url) => {
    try {
      const h = new URL(url).hostname;
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '[::1]') return true;
      if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h) || /^169\.254\./.test(h)) return true;
      if (h.endsWith('.local') || h.endsWith('.internal')) return true;
    } catch (e) {}
    return false;
  };
  const origFetch = window.fetch;
  window.fetch = function(input, init) { const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input)); if (fpSettings.localNetBlock && isLocalIP(url)) return Promise.reject(new TypeError('Failed to fetch')); return origFetch.call(this, input, init); };
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, url, ...r) { if (typeof url === 'string' && fpSettings.localNetBlock && isLocalIP(url)) this._fpsync_blocked = true; return origXHROpen.call(this, m, url, ...r); };
  XMLHttpRequest.prototype.send = function(body) { if (this._fpsync_blocked) { const x = this; setTimeout(() => { try { Object.defineProperty(x, 'readyState', { value: 4, writable: false }); Object.defineProperty(x, 'status', { value: 0, writable: false }); if (x.onerror) x.onerror(new Event('error')); } catch (e) {} }, 5 + Math.floor(Math.random() * 20)); return; } return origXHRSend.call(this, body); };

  // ═══════════════════════════════════════════════════════════════
  // 18. LINK CLEANER
  // ═════════════════════════════════════════════════════════════
  const TRACKING_PARAMS = new Set([
    'utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id',
    '_ga','_gl','_gid','gclsrc','gclid','gad_source','gbraid','wbraid',
    'fbclid','msclkid','twclid','li_fat_id','mc_eid','mc_cid','_openstat','yclid','ysclid',
    'from','igshid','si','feature','ref_code','affiliate_id','click_id','clickid','mkt_tok',
  ]);
  const CUSTOM_PREFIXES = [];
  function matchesTrackingParam(key) {
    const lk = key.toLowerCase();
    if (TRACKING_PARAMS.has(key) || TRACKING_PARAMS.has(lk)) return true;
    for (const p of CUSTOM_PREFIXES) { if (lk.startsWith(p)) return true; }
    return false;
  }
  function cleanUrlParams(url) {
    try {
      const p = new URL(url, location.origin);
      for (const k of [...p.searchParams.keys()]) { if (matchesTrackingParam(k)) p.searchParams.delete(k); }
      let c = p.toString(); if (c.endsWith('?')) c = c.slice(0, -1); return c;
    } catch (e) { return url; }
  }
  function initLinkCleaner() {
    if (!fpSettings.linkCleaner || !fpSettings.linkCleaner.enabled) return;
    if (fpSettings.linkCleaner.aggressive) {
      ['ref','referrer','source','campaign','ad_id','session','tracking_id','visitor_id','token','debug','log','version','build','tab','panel','section','card','searchlog'].forEach(p => TRACKING_PARAMS.add(p));
      ['utm_','cm_','pk_','ef_','hj_','hs_','mkto_','_ga','_gl','_hs','mc_','mkt_'].forEach(p => CUSTOM_PREFIXES.push(p));
    }
    if (fpSettings.linkCleaner.customParams) fpSettings.linkCleaner.customParams.split('\n').forEach(p => { if (p.trim()) TRACKING_PARAMS.add(p.trim()); });
    if (fpSettings.linkCleaner.customPrefixes) fpSettings.linkCleaner.customPrefixes.split('\n').forEach(p => { if (p.trim()) CUSTOM_PREFIXES.push(p.trim().toLowerCase()); });

    function doClean() {
      try { const url = location.href; if (!url.includes('?')) return; const c = cleanUrlParams(url); if (c !== url) history.replaceState(null, '', c); } catch (e) {}
    }
    if (document.readyState === 'complete') doClean(); else window.addEventListener('load', doClean);
    const origPS = history.pushState;
    const origRS = history.replaceState;
    history.pushState = function(s, t, u) { if (typeof u === 'string' && u.includes('?')) u = cleanUrlParams(u); return origPS.call(this, s, t, u); };
    history.replaceState = function(s, t, u) { if (typeof u === 'string' && u.includes('?')) u = cleanUrlParams(u); return origRS.call(this, s, t, u); };
    document.addEventListener('click', function(e) {
      const a = e.target.closest('a');
      if (a && a.href) { try { const c = cleanUrlParams(a.href); if (c !== a.href) a.href = c; } catch (ex) {} }
    }, true);
  }

  // ═══════════════════════════════════════════════════════════════
  // 19. PROFILE LOADER — MutationObserver waits for __fpsync_data
  // ═══════════════════════════════════════════════════════════════
  function onProfileReady() {
    if (_ready) return;
    _ready = true;
    // Apply deferred overrides that need profile data
    applyTimezone();
    applyGeolocation();
    applyGPC();
    initLinkCleaner();
    // Protocol blocker needs fpSettings
    if (fpSettings.protocolBlock) {
      new MutationObserver((mutations) => {
        for (const m of mutations) { for (const n of m.addedNodes) { if (n.nodeName === 'IFRAME') try { if (typeof n.src === 'string' && isCustomProtocol(n.src)) { const match = n.src.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/); if (match && BLOCKED_PROTOCOLS.has(match[1].toLowerCase())) n.src = 'about:blank'; } } catch (e) {} } }
      }).observe(document, { childList: true, subtree: true });
      if (navigator.registerProtocolHandler) navigator.registerProtocolHandler = function() {};
      if (navigator.isProtocolHandlerRegistered) navigator.isProtocolHandlerRegistered = function() { return false; };
    }
  }

  // Check if data element already exists (rare but possible)
  const existingEl = document.getElementById('__fpsync_data');
  if (existingEl) {
    if (existingEl.getAttribute('data-skip') === '1') return; // Disabled/blacklisted
    try {
      const raw = existingEl.getAttribute('data-profile');
      if (raw) profile = JSON.parse(decodeURIComponent(raw));
    } catch (e) {}
    try {
      const rawS = existingEl.getAttribute('data-settings');
      if (rawS) fpSettings = JSON.parse(decodeURIComponent(rawS));
    } catch (e) {}
    existingEl.remove();
    if (profile) { _prngState = profile.seed | 0; onProfileReady(); }
  } else {
    // Wait for data element via MutationObserver
    const observer = new MutationObserver((mutations, obs) => {
      const el = document.getElementById('__fpsync_data');
      if (!el) return;
      obs.disconnect();
      if (el.getAttribute('data-skip') === '1') return; // Disabled/blacklisted
      try {
        const raw = el.getAttribute('data-profile');
        if (raw) profile = JSON.parse(decodeURIComponent(raw));
      } catch (e) {}
      try {
        const rawS = el.getAttribute('data-settings');
        if (rawS) fpSettings = JSON.parse(decodeURIComponent(rawS));
      } catch (e) {}
      el.remove();
      if (profile) { _prngState = profile.seed | 0; onProfileReady(); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // Safety timeout — if profile never arrives, hooks stay in pass-through mode
    setTimeout(() => observer.disconnect(), 3000);
  }

})();
