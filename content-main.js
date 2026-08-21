/**
 * FingerprintSync — MAIN world content script
 * Injected IMMEDIATELY at document_start (before any page JS).
 *
 * Architecture:
 *   Phase 1 (IMMEDIATE, document_start):
 *     - Save ALL original API references
 *     - Install CANVAS hooks immediately (with random temp seed)
 *       → prevents ANY page JS from seeing real canvas data
 *   Phase 2 (after profile arrives via MutationObserver):
 *     - Re-seed PRNG with profile seed for deterministic noise
 *     - Install Navigator/Screen/WebGL/Audio/etc hooks (need profile data)
 *   Blacklisted sites: receive data-skip → Phase 2 skipped, canvas hooks remain
 *     (canvas hooks with temp seed are harmless, just adds random noise)
 */

'use strict';

(function FingerprintSyncMain() {
  // Prevent double-injection
  const MARKER = '__fpsync_main';
  if (document.documentElement.dataset[MARKER]) return;
  document.documentElement.dataset[MARKER] = '1';
  setTimeout(() => delete document.documentElement.dataset[MARKER], 2000);

  // ─── Profile state ───
  let profile = null;
  // Use crypto-based random seed initially so canvas noise is ALWAYS active
  // even before profile arrives. Re-seeded with profile.seed when ready.
  let _prngState = (crypto.getRandomValues(new Uint32Array(1))[0]) | 1;
  let fpSettings = { webrtcBlock: true, localNetBlock: true, protocolBlock: true, linkCleaner: { enabled: true, aggressive: false, customParams: '', customPrefixes: '' } };
  let _ready = false;
  let _profileHooksInstalled = false;

  function prngNext() {
    let t = (_prngState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function prngInt(min, max) {
    return min + Math.floor(prngNext() * (max - min + 1));
  }

  // ─── Helper: define property on prototype chain ───
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
  // PHASE 1 — IMMEDIATE canvas hooks (BEFORE any page JS runs)
  // This prevents race conditions where page scripts grab
  // original toDataURL/getImageData references before we hook them.
  // ═══════════════════════════════════════════════════════════════

  // Save canvas originals IMMEDIATELY
  const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const _origToBlob = HTMLCanvasElement.prototype.toBlob;
  const _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  const _origGetContext = HTMLCanvasElement.prototype.getContext;

  function applyCanvasNoise(ctx, canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;
    const imgData = _origGetImageData.call(ctx, 0, 0, w, h);
    const data = imgData.data;
    const len = data.length;
    const threshold = 0.03 + prngNext() * 0.02;
    let modified = 0;
    for (let i = 0; i < len; i += 4) {
      if (prngNext() < threshold) {
        const offset = prngNext() > 0.5 ? 1 : -1;
        data[i] = Math.max(0, Math.min(255, data[i] + offset));
        if (prngNext() < 0.3) data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + offset));
        if (prngNext() < 0.2) data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + offset));
        modified++;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return modified;
  }

  function getOffscreenCopy(canvas) {
    const off = document.createElement('canvas');
    off.width = canvas.width; off.height = canvas.height;
    const octx = off.getContext('2d');
    if (octx) octx.drawImage(canvas, 0, 0);
    return { canvas: off, ctx: octx };
  }

  // Hook toDataURL IMMEDIATELY — runs before ANY page script
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const { canvas: off, ctx: offCtx } = getOffscreenCopy(this);
      if (offCtx) applyCanvasNoise(offCtx, off);
      return _origToDataURL.apply(off, args);
    }
    return _origToDataURL.apply(this, args);
  };

  // Hook toBlob IMMEDIATELY
  HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const { canvas: off, ctx: offCtx } = getOffscreenCopy(this);
      if (offCtx) applyCanvasNoise(offCtx, off);
      return _origToBlob.apply(off, [callback, ...args]);
    }
    return _origToBlob.apply(this, [callback, ...args]);
  };

  // Hook getImageData IMMEDIATELY
  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const imgData = _origGetImageData.apply(this, args);
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

  console.log('[FPSync v2.0.2] Phase 1: Canvas hooks active at', performance.now().toFixed(1), 'ms, seed:', _prngState);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2 — Profile-dependent hooks (installed AFTER profile arrives)
  // These need profile data (UA, screen, GPU, etc.)
  // ═══════════════════════════════════════════════════════════════
  function installProfileHooks() {
    if (_profileHooksInstalled) return;
    _profileHooksInstalled = true;

    // ── 1. NAVIGATOR OVERRIDES ──
    const _origNav = {};
    const _navProps = ['userAgent','appVersion','platform','vendor','language','languages','hardwareConcurrency','deviceMemory','userAgentData','doNotTrack'];
    for (const p of _navProps) {
      let cur = Navigator.prototype;
      while (cur) {
        try {
          const d = Object.getOwnPropertyDescriptor(cur, p);
          if (d) { _origNav[p] = d.get || d.value; break; }
        } catch(e) {}
        cur = Object.getPrototypeOf(cur);
      }
    }
    function origNavVal(prop) {
      const v = _origNav[prop];
      return typeof v === 'function' ? v.call(navigator) : v;
    }

    definePropOnChain(Navigator.prototype, 'userAgent', () => profile.ua);
    definePropOnChain(Navigator.prototype, 'appVersion', () => profile.appVersion);
    definePropOnChain(Navigator.prototype, 'platform', () => profile.platform);
    definePropOnChain(Navigator.prototype, 'vendor', () => profile.vendor);
    definePropOnChain(Navigator.prototype, 'language', () => profile.language);
    definePropOnChain(Navigator.prototype, 'languages', () => Object.freeze([...profile.languages]));
    definePropOnChain(Navigator.prototype, 'hardwareConcurrency', () => profile.hardwareConcurrency);
    definePropOnChain(Navigator.prototype, 'deviceMemory', () => profile.deviceMemory);
    if (typeof _origNav.doNotTrack !== 'undefined') {
      definePropOnChain(Navigator.prototype, 'doNotTrack', () => profile.dnt !== undefined ? profile.dnt : origNavVal('doNotTrack'));
    }
    if (typeof _origNav.userAgentData !== 'undefined') {
      definePropOnChain(Navigator.prototype, 'userAgentData', () => profile.userAgentData);
    }
    // Plugins/mimeTypes — empty (modern Chrome)
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

    // ── 2. SCREEN OVERRIDES ──
    definePropOnChain(Screen.prototype, 'width', () => profile.screen.width);
    definePropOnChain(Screen.prototype, 'height', () => profile.screen.height);
    definePropOnChain(Screen.prototype, 'availWidth', () => profile.screen.availWidth);
    definePropOnChain(Screen.prototype, 'availHeight', () => profile.screen.availHeight);
    definePropOnChain(Screen.prototype, 'colorDepth', () => profile.screen.colorDepth);
    definePropOnChain(Screen.prototype, 'pixelDepth', () => profile.screen.colorDepth);

    // ── 3. WEBGL FINGERPRINT ──
    // Note: getContext is already hooked by canvas phase. We hook it again here
    // for WebGL-specific logic. Since it's a direct prototype assignment,
    // this replaces the phase 1 hook.
    function hookWebGLGetParameter(gpu) {
      return function(pname) {
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

    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const ctx = _origGetContext.call(this, type, ...args);
      if (!ctx) return ctx;
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

    // ── 4. AUDIO FINGERPRINT ──
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = origGetChannelData.call(this, channel);
      for (let i = 0; i < data.length; i += 100) {
        data[i] += (prngNext() - 0.5) * 0.0001;
      }
      return data;
    };

    // ── 5. FONT FINGERPRINT ──
    if (document.fonts && document.fonts.check) {
      const origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function(font, text) {
        const name = (font.match(/"?([^",]+)"?/) || [])[1];
        if (name && profile.fonts && !profile.fonts.includes(name)) return false;
        return origCheck(font, text);
      };
    }

    // ── 6. CLIENTRECTS NOISE ──
    const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() {
      const rect = origGetBoundingClientRect.call(this);
      const noise = (prngNext() - 0.5) * 0.5;
      return new DOMRect(rect.x + noise, rect.y + noise, rect.width, rect.height);
    };

    // ── 7. WEBGPU ──
    if (navigator.gpu) {
      const origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = async function(...args) {
        if (args[0] && typeof args[0] === 'object' && 'powerPreference' in args[0]) {
          const { powerPreference, ...rest } = args[0];
          args[0] = rest;
        }
        const adapter = await origRequestAdapter(...args);
        if (!adapter) return adapter;
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

    // ── 8. TIMEZONE ──
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

    // ── 9. GEOLOCATION ──
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
    navigator.geolocation.getCurrentPosition = function(s, e, o) { if (s) setTimeout(() => s(makePos()), 50 + prngInt(0, 100)); };
    navigator.geolocation.watchPosition = function(s, e, o) { if (s) { const id = setInterval(() => s(makePos()), 5000); return prngInt(1, 99999); } return prngInt(1, 99999); };

    // ── 10. MATCH MEDIA / PREFERENCES ──
    const origMatchMedia = window.matchMedia;
    window.matchMedia = function(q) {
      const r = origMatchMedia.call(this, q);
      if (q === '(prefers-color-scheme: dark)') {
        const mql = Object.create(MediaQueryList.prototype);
        Object.defineProperty(mql, 'matches', { value: prngNext() < 0.45, writable: false, configurable: true });
        Object.defineProperty(mql, 'media', { value: r.media, writable: false, configurable: true });
        mql.addEventListener = r.addEventListener.bind(r);
        mql.removeEventListener = r.removeEventListener.bind(r);
        mql.addListener = r.addListener ? r.addListener.bind(r) : undefined;
        mql.removeListener = r.removeListener ? r.removeListener.bind(r) : undefined;
        mql.dispatchEvent = r.dispatchEvent.bind(r);
        mql.onchange = null;
        return mql;
      }
      if (q === '(prefers-reduced-motion: reduce)') {
        const mql = Object.create(MediaQueryList.prototype);
        Object.defineProperty(mql, 'matches', { value: false, writable: false, configurable: true });
        Object.defineProperty(mql, 'media', { value: r.media, writable: false, configurable: true });
        mql.addEventListener = r.addEventListener.bind(r);
        mql.removeEventListener = r.removeEventListener.bind(r);
        mql.addListener = r.addListener ? r.addListener.bind(r) : undefined;
        mql.removeListener = r.removeListener ? r.removeListener.bind(r) : undefined;
        mql.dispatchEvent = r.dispatchEvent.bind(r);
        return mql;
      }
      return r;
    };

    // ── 11. GLOBAL PRIVACY CONTROL ──
    if (profile.gpc) {
      try { Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, enumerable: true, get: () => true }); } catch (e) {}
    }

    // ── 12. PERFORMANCE TIMING LEAK REDUCTION ──
    try {
      const origNow = performance.now.bind(performance);
      const PRECISION = 0.1;
      Object.defineProperty(performance, 'now', { configurable: true, value: function() { return Math.floor(origNow() / PRECISION) * PRECISION; } });
    } catch (e) {}

    // ── 13. WEBRTC IP LEAK PROTECTION ──
    if (window.RTCPeerConnection) {
      const OrigRTC = window.RTCPeerConnection;
      const BLOCKED_EVENTS = new Set(['icecandidate','icegatheringstatechange','iceconnectionstatechange','icecandidateerror']);

      function neuterRTC(instance) {
        if (!fpSettings.webrtcBlock) return instance;
        const origCreateOffer = instance.createOffer.bind(instance);
        instance.createOffer = async function(o) { const offer = await origCreateOffer(o || {}); if (offer.sdp) offer.sdp = offer.sdp.replace(/a=candidate:.+\r?\n/g, ''); return offer; };
        const origSetLocalDesc = instance.setLocalDescription.bind(instance);
        instance.setLocalDescription = async function(d) { if (d && d.sdp) d.sdp = d.sdp.replace(/a=candidate:.+\r?\n/g, ''); return origSetLocalDesc(d); };
        Object.defineProperty(instance, 'onicecandidate', { configurable: true, get() { return null; }, set() {} });
        Object.defineProperty(instance, 'iceGatheringState', { configurable: true, get: () => 'new' });
        const origAddEventListener = instance.addEventListener.bind(instance);
        instance.addEventListener = function(type, listener, ...args) {
          if (BLOCKED_EVENTS.has(type)) return;
          return origAddEventListener(type, listener, ...args);
        };
        const origRemoveEventListener = instance.removeEventListener.bind(instance);
        instance.removeEventListener = function(type, listener, ...args) {
          if (BLOCKED_EVENTS.has(type)) return;
          return origRemoveEventListener(type, listener, ...args);
        };
        try {
          const origLD = Object.getOwnPropertyDescriptor(OrigRTC.prototype, 'localDescription');
          if (origLD && origLD.get) {
            Object.defineProperty(instance, 'localDescription', { configurable: true, get: () => { const d = origLD.get.call(instance); if (d && d.sdp) return { type: d.type, sdp: d.sdp.replace(/a=candidate:.+\r?\n/g, '') }; return d; } });
          }
        } catch (e) {}
        const origGetStats = instance.getStats.bind(instance);
        instance.getStats = async function() { const s = await origGetStats(); if (s instanceof Map) { const c = new Map(); for (const [k, v] of s) { if (v && (v.type === 'local-candidate' || (v.type === 'candidate-pair' && v.localCandidateId))) continue; c.set(k, v); } return c; } return s; };
        return instance;
      }

      window.RTCPeerConnection = function(config, constraints) {
        const safeConfig = { ...(config || {}), iceServers: [] };
        const instance = new OrigRTC(safeConfig, constraints);
        return neuterRTC(instance);
      };
      window.RTCPeerConnection.prototype = OrigRTC.prototype;
      try { window.RTCPeerConnection.generateCertificate = OrigRTC.generateCertificate; } catch(e) {}
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = window.RTCPeerConnection;
    }

    // ── 14. CUSTOM PROTOCOL SCHEME PROTECTION ──
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

    // ── 15. LOCAL NETWORK PROBING PROTECTION ──
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
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
      
      if (fpSettings.localNetBlock && isLocalIP(url)) return Promise.reject(new TypeError('Failed to fetch'));
      return origFetch.call(this, input, init);
    };
    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, url, ...r) { if (typeof url === 'string' && fpSettings.localNetBlock && isLocalIP(url)) this._fpsync_blocked = true; return origXHROpen.call(this, m, url, ...r); };
    XMLHttpRequest.prototype.send = function(body) { if (this._fpsync_blocked) { const x = this; setTimeout(() => { try { Object.defineProperty(x, 'readyState', { value: 4, writable: false }); Object.defineProperty(x, 'status', { value: 0, writable: false }); if (x.onerror) x.onerror(new Event('error')); } catch (e) {} }, 5 + Math.floor(Math.random() * 20)); return; } return origXHRSend.call(this, body); };

    // ── 16. LINK CLEANER ──
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
    initLinkCleaner();

    // ── 17. PROTOCOL BLOCKER (iframe mutation observer) ──
    if (fpSettings.protocolBlock) {
      new MutationObserver((mutations) => {
        for (const m of mutations) { for (const n of m.addedNodes) { if (n.nodeName === 'IFRAME') try { if (typeof n.src === 'string' && isCustomProtocol(n.src)) { const match = n.src.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/); if (match && BLOCKED_PROTOCOLS.has(match[1].toLowerCase())) n.src = 'about:blank'; } } catch (e) {} } }
      }).observe(document, { childList: true, subtree: true });
      if (navigator.registerProtocolHandler) navigator.registerProtocolHandler = function() {};
      if (navigator.isProtocolHandlerRegistered) navigator.isProtocolHandlerRegistered = function() { return false; };
    }

    
  }

  // ═══════════════════════════════════════════════════════════════
  // PROFILE LOADER — MutationObserver waits for __fpsync_data
  // ═══════════════════════════════════════════════════════════════
  function onProfileReady() {
    if (_ready) return;
    _ready = true;
    _prngState = profile.seed | 0;
    console.log('[FPSync] Phase 2: Profile loaded, seed:', _prngState, 'at', performance.now().toFixed(1), 'ms');
    installProfileHooks();
  }

  // Check if data element already exists
  const existingEl = document.getElementById('__fpsync_data');
  if (existingEl) {
    if (existingEl.getAttribute('data-skip') === '1') return;
    try {
      const raw = existingEl.getAttribute('data-profile');
      if (raw) profile = JSON.parse(decodeURIComponent(raw));
    } catch (e) {}
    try {
      const rawS = existingEl.getAttribute('data-settings');
      if (rawS) fpSettings = JSON.parse(decodeURIComponent(rawS));
    } catch (e) {}
    existingEl.remove();
    if (profile) onProfileReady();
  } else {
    const observer = new MutationObserver((mutations, obs) => {
      const el = document.getElementById('__fpsync_data');
      if (!el) return;
      obs.disconnect();
      if (el.getAttribute('data-skip') === '1') return;
      try {
        const raw = el.getAttribute('data-profile');
        if (raw) profile = JSON.parse(decodeURIComponent(raw));
      } catch (e) {}
      try {
        const rawS = el.getAttribute('data-settings');
        if (rawS) fpSettings = JSON.parse(decodeURIComponent(rawS));
      } catch (e) {}
      el.remove();
      if (profile) onProfileReady();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 3000);
  }

})();
