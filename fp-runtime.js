/**
 * FingerprintSync v2.0.9 — MAIN world content script (Phase 2 only)
 * Injected at document_start via manifest "world": "MAIN".
 *
 * Canvas hooks are in canvas-hooks.js (loaded BEFORE this file).
 * This file handles Phase 2: Navigator/Screen/WebGL/Audio/etc. + re-seeds PRNG.
 *
 * v2.0.9: Canvas hooks now non-destructive (temp canvas approach).
 *   Removed willReadFrequently forcing that broke canvas games.
 *   v2.0.9: IFRAME FIX, Client Hints, DNT, DateTimeFormat locale, CSS MQ, WebGPU.
 */

(function FingerprintSyncMain() {
  // Prevent double-injection
  const MARKER = '__fpsync_main';
  if (document.documentElement.dataset[MARKER]) return;
  document.documentElement.dataset[MARKER] = '1';
  setTimeout(() => delete document.documentElement.dataset[MARKER], 2000);

  // ─── Profile state ───
  let profile = null;
  // Use the global PRNG from canvas-hooks.js for Phase 2 consistency
  const _globalPrng = window.__fpsync_prng;
  let _prngState = _globalPrng ? _globalPrng.getState() : ((crypto.getRandomValues(new Uint32Array(1))[0]) | 1);
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

  // Save original getContext for Phase 2 WebGL hooking
  const _origGetContext = HTMLCanvasElement.prototype.getContext;

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2 — Profile-dependent hooks
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

    // ── 2b. WINDOW DIMENSION CONSISTENCY ──
    // Prevent detection via impossible geometry: screen.width < window.innerWidth.
    // Compute spoofed window dimensions from profile screen + real chrome deltas.
    try {
      var _realOW = window.outerWidth, _realOH = window.outerHeight;
      var _realIW = window.innerWidth, _realIH = window.innerHeight;
      var _chromeW = _realOW - _realIW;
      var _chromeH = _realOH - _realIH;
      // Spoofed outer = screen available (simulates maximized window)
      var _sOW = profile.screen.availWidth || profile.screen.width;
      var _sOH = profile.screen.availHeight || profile.screen.height;
      var _sIW = Math.max(200, _sOW - _chromeW);
      var _sIH = Math.max(200, _sOH - _chromeH);
      // Safety: inner must not exceed screen
      if (_sIW >= profile.screen.width) _sIW = profile.screen.width - 1;
      if (_sIH >= profile.screen.height) _sIH = profile.screen.height - 1;
      try { Object.defineProperty(window, 'innerWidth',  { configurable: true, get: function() { return _sIW; } }); } catch(e) {}
      try { Object.defineProperty(window, 'innerHeight', { configurable: true, get: function() { return _sIH; } }); } catch(e) {}
      try { Object.defineProperty(window, 'outerWidth',  { configurable: true, get: function() { return _sOW; } }); } catch(e) {}
      try { Object.defineProperty(window, 'outerHeight', { configurable: true, get: function() { return _sOH; } }); } catch(e) {}
      console.log('[FPSync v2.0.9] Screen: inner', _sIW, 'x', _sIH, '| outer', _sOW, 'x', _sOH, '| chrome', _chromeW, 'x', _chromeH);
    } catch(e) {}

    // ── 2c. DOCUMENT ELEMENT DIMENSIONS + DPR ──
    // document.documentElement.clientWidth/Height must match spoofed innerWidth/innerHeight
    try {
      var _elProto = Element.prototype;
      var _cwDesc = Object.getOwnPropertyDescriptor(_elProto, 'clientWidth');
      var _chDesc = Object.getOwnPropertyDescriptor(_elProto, 'clientHeight');
      if (_cwDesc && _cwDesc.get && _cwDesc.configurable) {
        var _origCWGet = _cwDesc.get;
        Object.defineProperty(_elProto, 'clientWidth', {
          configurable: true, enumerable: true,
          get: function() { return (this === document.documentElement) ? _sIW : _origCWGet.call(this); }
        });
      }
      if (_chDesc && _chDesc.get && _chDesc.configurable) {
        var _origCHGet = _chDesc.get;
        Object.defineProperty(_elProto, 'clientHeight', {
          configurable: true, enumerable: true,
          get: function() { return (this === document.documentElement) ? _sIH : _origCHGet.call(this); }
        });
      }
      if (profile.screen.devicePixelRatio !== undefined) {
        try { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: function() { return profile.screen.devicePixelRatio; } }); } catch(ede) {}
      }
      console.log('[FPSync v2.0.9] DocElement dims + DPR hook OK');
    } catch(e) { console.warn('[FPSync v2.0.9] DocElement dims failed:', e); }

    // ── 3. WEBGL FINGERPRINT ──
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
    // 5a. document.fonts.check() — blocks API-based font enumeration
    if (document.fonts && document.fonts.check) {
      const origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function(font, text) {
        const name = (font.match(/"?([^",]+)"?/) || [])[1];
        if (name && profile.fonts && !profile.fonts.includes(name)) return false;
        return origCheck(font, text);
      };
    }

    // 5b. DOM-based font detection (offsetWidth/offsetHeight fallback method)
    // browserleaks.com/fonts creates a <span>, sets fontFamily to a candidate name,
    // and compares offsetWidth/offsetHeight against a bogus-font baseline.
    // We Proxy the Element.prototype.style accessor so that fontFamily assignments
    // for non-profile fonts get replaced with a nonexistent name → same fallback
    // metrics → fingerprinter concludes "font not installed".
    if (profile.fonts && profile.fonts.length) {
      const _fontSet = new Set(profile.fonts.map(function(f) { return f.toLowerCase(); }));
      var _FAKE_FONT = '__fpsync_no_font_7x3k9__';
      var _GENERICS = new Set([
        'sans-serif','serif','monospace','cursive','fantasy','system-ui',
        'ui-serif','ui-sans-serif','ui-monospace','ui-rounded',
        'emoji','math','fangsong','inherit','initial','default'
      ]);

      // Parse comma-separated font names from a CSS font-family value
      function extractFontNames(cssValue) {
        if (typeof cssValue !== 'string') return [];
        var names = [], current = '', inQuote = false, quoteChar = '';
        for (var i = 0; i < cssValue.length; i++) {
          var ch = cssValue[i];
          if (inQuote) {
            if (ch === quoteChar) inQuote = false;
            else current += ch;
          } else if (ch === '"' || ch === "'") {
            inQuote = true; quoteChar = ch;
          } else if (ch === ',') {
            var t = current.trim(); if (t) names.push(t); current = '';
          } else {
            current += ch;
          }
        }
        var last = current.trim(); if (last) names.push(last);
        return names;
      }

      // Filter font-family value: keep only profile fonts + generics
      function filterFontValue(cssValue) {
        var names = extractFontNames(cssValue);
        if (names.length === 0) return cssValue;
        var filtered = [];
        for (var i = 0; i < names.length; i++) {
          var n = names[i].trim(), lower = n.toLowerCase();
          if (_GENERICS.has(lower) || _fontSet.has(lower)) filtered.push(n);
        }
        if (filtered.length === 0) return _FAKE_FONT;
        return filtered.map(function(name) {
          if (name.indexOf(' ') > -1 && name[0] !== '"' && name[0] !== "'") return '"' + name + '"';
          return name;
        }).join(', ');
      }

      // ── Proxy on Element.prototype.style ──
      try {
        var _targetProto = HTMLElement.prototype || Element.prototype;
        var _styleAccDesc = Object.getOwnPropertyDescriptor(_targetProto, 'style');
        if (!_styleAccDesc) _styleAccDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'style');
        if (_styleAccDesc && _styleAccDesc.get) {
          var _origStyleGet = _styleAccDesc.get;
          var _proxyCache = new WeakMap();
          Object.defineProperty(_targetProto, 'style', {
            configurable: true, enumerable: true,
            get: function() {
              var real = _origStyleGet.call(this);
              if (!real) return real;
              if (_proxyCache.has(real)) return _proxyCache.get(real);
              var proxy = new Proxy(real, {
                set: function(target, prop, value) {
                  if (prop === 'fontFamily' && typeof value === 'string') {
                    value = filterFontValue(value);
                  }
                  target[prop] = value;
                  return true;
                },
                get: function(target, prop) {
                  if (prop === 'setProperty') {
                    return function(name, value, priority) {
                      if (typeof name === 'string' && name.toLowerCase() === 'font-family' && typeof value === 'string') {
                        value = filterFontValue(value);
                      }
                      return target.setProperty.call(target, name, value, priority);
                    };
                  }
                  if (prop === '__fpsync_fp') return true;
                  var val = target[prop];
                  if (typeof val === 'function') return val.bind(target);
                  return val;
                }
              });
              _proxyCache.set(real, proxy);
              return proxy;
            },
            set: _styleAccDesc.set
          });
          console.log('[FPSync v2.0.9] Font: Proxy on style installed OK');
        } else {
          console.warn('[FPSync v2.0.9] Font: No style accessor descriptor');
        }
      } catch (e) {
        console.warn('[FPSync v2.0.9] Font: Proxy install failed:', e);
      }

      // Also hook setAttribute('style', ...) — not covered by Proxy
      var origSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {
        if (name && name.toLowerCase() === 'style' && typeof value === 'string' && value.toLowerCase().includes('font-family')) {
          value = value.replace(/font-family\s*:\s*([^;"']+|"[^"]*"|'[^']*')/gi, function(match, fontVal) {
            return 'font-family: ' + filterFontValue(fontVal);
          });
        }
        return origSetAttribute.call(this, name, value);
      };

    }

    // ── 6. CLIENTRECTS + OFFSET NOISE ──
    // 6a. getBoundingClientRect noise (sub-pixel, non-breaking)
    const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() {
      const rect = origGetBoundingClientRect.call(this);
      const nx = (prngNext() - 0.5) * 0.5;
      const ny = (prngNext() - 0.5) * 0.5;
      const nw = (prngNext() - 0.5) * 0.4;
      const nh = (prngNext() - 0.5) * 0.4;
      return new DOMRect(rect.x + nx, rect.y + ny, rect.width + nw, rect.height + nh);
    };

    // 6b. offsetWidth / offsetHeight noise (Font Fingerprint Defender approach)
    // Adds ±1 px noise to defeat font metrics & Unicode glyph fingerprinting.
    try {
      var _offsetProto = HTMLElement.prototype;
      var _owDesc = Object.getOwnPropertyDescriptor(_offsetProto, 'offsetWidth');
      var _ohDesc = Object.getOwnPropertyDescriptor(_offsetProto, 'offsetHeight');
      if (_owDesc && _owDesc.get) {
        var _origOWGet = _owDesc.get;
        Object.defineProperty(_offsetProto, 'offsetWidth', {
          configurable: true, enumerable: true,
          get: function() {
            var w = _origOWGet.call(this);
            var r = prngNext();
            if (r < 0.29) return Math.max(0, w + 1);
            if (r < 0.58) return Math.max(0, w - 1);
            return Math.max(0, w);
          }
        });
      }
      if (_ohDesc && _ohDesc.get) {
        var _origOHGet = _ohDesc.get;
        Object.defineProperty(_offsetProto, 'offsetHeight', {
          configurable: true, enumerable: true,
          get: function() {
            var h = _origOHGet.call(this);
            var r = prngNext();
            if (r < 0.29) return Math.max(0, h + 1);
            if (r < 0.58) return Math.max(0, h - 1);
            return Math.max(0, h);
          }
        });
      }
      console.log('[FPSync v2.0.9] Offset noise installed (ow:', !!_owDesc, 'oh:', !!_ohDesc, ')');
    } catch(e) {
      console.warn('[FPSync v2.0.9] Offset noise failed:', e);
    }

    // ── 7. WEBGPU ──
    // v2.0.9: Also proxy adapter.features and adapter.limits (not just adapter.info)
    if (navigator.gpu) {
      const origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
      const _wgpuFeatures = new Set(profile.webgpu.features || []);
      const _wgpuLimits = {
        maxTextureDimension1D: profile.gpu.maxTextureSize, maxTextureDimension2D: profile.gpu.maxTextureSize,
        maxTextureArrayLayers: 256, maxBindGroups: 4,
      };
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
                vendor: webgpu.vendor, architecture: webgpu.architecture, device: webgpu.device,
                description: webgpu.description, features: _wgpuFeatures,
                limits: _wgpuLimits,
              };
            }
            // v2.0.9: Proxy direct adapter.features and adapter.limits
            if (prop === 'features') return _wgpuFeatures;
            if (prop === 'limits') return _wgpuLimits;
            const val = target[prop];
            if (typeof val === 'function') return val.bind(target);
            return val;
          },
        });
      };
    }

    // ── 8. TIMEZONE (Intl.DateTimeFormat) ──
    // Fixed: sets timeZone OPTION (not locale) so formatting actually uses spoofed TZ
    // v2.0.9: Also forces locale from profile language (e.g. ja-JP instead of real browser locale ru)
    try {
      var origDateTimeFormat = Intl.DateTimeFormat;
      var _origDTFSupportedLocalesOf = origDateTimeFormat.supportedLocalesOf;
      var _profileLocale = profile.language || undefined;
      Intl.DateTimeFormat = function(...args) {
        // Force profile locale if no explicit locale provided or if using browser default
        if (!args[0] || (typeof args[0] === 'undefined')) args[0] = _profileLocale;
        if (!args[1] || typeof args[1] !== 'object') args[1] = {};
        if (!args[1].timeZone) args[1].timeZone = profile.timezone;
        return new origDateTimeFormat(args[0], args[1]);
      };
      Intl.DateTimeFormat.prototype = origDateTimeFormat.prototype;
      if (_origDTFSupportedLocalesOf) Intl.DateTimeFormat.supportedLocalesOf = _origDTFSupportedLocalesOf;
      if (origDateTimeFormat.supportedValuesOf) {
        var origSV = origDateTimeFormat.supportedValuesOf;
        Object.defineProperty(Intl.DateTimeFormat, 'supportedValuesOf', {
          configurable: true,
          value: function(key) {
            if (key === 'timeZone') {
              var all = origSV.call(origDateTimeFormat, key);
              if (!all.includes(profile.timezone)) return all.concat([profile.timezone]);
              return all;
            }
            return origSV.call(origDateTimeFormat, key);
          },
        });
      }
    } catch (e) {}

    // ── 8b. DATE/TIME SYNCHRONIZATION ──
    // Shifts Date so that local-time methods (getHours etc.) show spoofed TZ time.
    // Also hooks toString/toTimeString to replace timezone name.
    // Compensates Intl.DateTimeFormat.format() for shifted Dates.
    try {
      var _realTzOff = new Date().getTimezoneOffset(); // minutes west of UTC
      // Compute spoofed timezone offset via Intl
      var _tzProbe = new Date();
      var _tzParts = new origDateTimeFormat('en-US', {
        timeZone: profile.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).formatToParts(_tzProbe);
      var _getP = function(t) { var p = _tzParts.find(function(x) { return x.type === t; }); return p ? parseInt(p.value) : 0; };
      var _sy = _getP('year'), _sm = _getP('month') - 1, _sd = _getP('day');
      var _sh = _getP('hour'), _smin = _getP('minute'), _ss = _getP('second');
      if (_sh === 24) _sh = 0;
      var _spoofedAsUTC = Date.UTC(_sy, _sm, _sd, _sh, _smin, _ss);
      var _realAsUTC = Date.UTC(_tzProbe.getUTCFullYear(), _tzProbe.getUTCMonth(), _tzProbe.getUTCDate(),
                                  _tzProbe.getUTCHours(), _tzProbe.getUTCMinutes(), _tzProbe.getUTCSeconds());
      var _tzDiffMs = _spoofedAsUTC - _realAsUTC;
      if (_tzDiffMs > 43200000) _tzDiffMs -= 86400000;
      if (_tzDiffMs < -43200000) _tzDiffMs += 86400000;
      // _tzDiffMs = spoofed TZ offset from UTC in ms (positive = east)
      var _spoofedTzOff = -Math.round(_tzDiffMs / 60000); // minutes west of UTC (getTimezoneOffset convention)
      // Shift to apply to Date internal time
      var _dateShift = (_realTzOff - _spoofedTzOff) * 60000;
      // Timezone abbreviation
      var _tzAbbrParts = new origDateTimeFormat('en-US', { timeZone: profile.timezone, timeZoneName: 'short' }).formatToParts(new Date());
      var _tzAbbr = ((_tzAbbrParts.find(function(p) { return p.type === 'timeZoneName'; })) || {}).value || '';
      // GMT offset string like "GMT+0200"
      var _eastMin = -_spoofedTzOff;
      var _gmSign = _eastMin >= 0 ? '+' : '-';
      var _absEast = Math.abs(_eastMin);
      var _gmStr = 'GMT' + _gmSign + String(Math.floor(_absEast / 60)).padStart(2, '0') + String(_absEast % 60).padStart(2, '0');

      // Save original Date methods
      var _OrigDate = Date;
      var _origDateNow = _OrigDate.now;
      var _origDProtoToStr = _OrigDate.prototype.toString;
      var _origDProtoToTimeStr = _OrigDate.prototype.toTimeString;
      var _tzRe = /GMT[+-]\d{4}\s*\([^)]*\)/;

      // Replace Date constructor via Proxy
      window.Date = new Proxy(_OrigDate, {
        construct: function(target, args) {
          if (args.length === 0) return new target(_origDateNow() + _dateShift);
          return new target(...args);
        },
        apply: function(target, thisArg, args) {
          var d = new _OrigDate(_origDateNow() + _dateShift);
 return _origDProtoToStr.call(d).replace(_tzRe, _gmStr + ' (' + _tzAbbr + ')');
        }
      });
      window.Date.now = function() { return _origDateNow() + _dateShift; };
      window.Date.parse = _OrigDate.parse;
      window.Date.UTC = _OrigDate.UTC;
      window.Date.prototype = _OrigDate.prototype;

      // Hook getTimezoneOffset
      _OrigDate.prototype.getTimezoneOffset = function() { return _spoofedTzOff; };
      // Hook toString / toTimeString — replace TZ name/offset
      _OrigDate.prototype.toString = function() {
        return _origDProtoToStr.call(this).replace(_tzRe, _gmStr + ' (' + _tzAbbr + ')');
      };
      _OrigDate.prototype.toTimeString = function() {
        return _origDProtoToTimeStr.call(this).replace(_tzRe, _gmStr + ' (' + _tzAbbr + ')');
      };

      // Hook Intl.DateTimeFormat.prototype.format/formatToParts to unshift Date
      // (Doubles are shifted so local methods show spoofed time; but Intl
      //  formatters apply spoofed TZ themselves → would double-shift)
      try {
        var _origFmt = origDateTimeFormat.prototype.format;
        var _origFmtParts = origDateTimeFormat.prototype.formatToParts;
        origDateTimeFormat.prototype.format = function(date) {
          if (date instanceof Date) date = new _OrigDate(date.getTime() - _dateShift);
          return _origFmt.call(this, date);
        };
        origDateTimeFormat.prototype.formatToParts = function(date) {
          if (date instanceof Date) date = new _OrigDate(date.getTime() - _dateShift);
          return _origFmtParts.call(this, date);
        };
        if (origDateTimeFormat.prototype.formatRange) {
          var _origFmtRange = origDateTimeFormat.prototype.formatRange;
          origDateTimeFormat.prototype.formatRange = function(s, e) {
            if (s instanceof Date) s = new _OrigDate(s.getTime() - _dateShift);
            if (e instanceof Date) e = new _OrigDate(e.getTime() - _dateShift);
            return _origFmtRange.call(this, s, e);
          };
        }
      } catch(ef) {}

      console.log('[FPSync v2.0.9] Date/Time: shift=' + _dateShift + 'ms TZ=' + profile.timezone + ' ' + _gmStr + ' (' + _tzAbbr + ')');
    } catch(e) { console.warn('[FPSync v2.0.9] Date/Time failed:', e); }

    // ── 9. GEOLOCATION ──
    const TZ_COORDS = {
      'America/New_York': { lat: 40.7128, lng: -74.006 }, 'America/Chicago': { lat: 41.8781, lng: -87.6298 },
      'America/Denver': { lat: 39.7392, lng: -104.9903 }, 'America/Los_Angeles': { lat: 34.0522, lng: -118.2437 },
      'America/Anchorage': { lat: 61.2181, lng: -149.9003 }, 'America/Sao_Paulo': { lat: -23.5505, lng: -46.6333 },
      'Europe/London': { lat: 51.5074, lng: -0.1278 }, 'Europe/Paris': { lat: 48.8566, lng: 2.3522 },
      'Europe/Berlin': { lat: 52.52, lng: 13.405 }, 'Europe/Moscow': { lat: 55.7558, lng: 37.6173 },
      'Europe/Amsterdam': { lat: 52.3676, lng: 4.9041 }, 'Europe/Madrid': { lat: 40.4168, lng: -3.7038 },
      'Europe/Rome': { lat: 41.9028, lng: 12.4964 }, 'Europe/Istanbul': { lat: 41.0082, lng: 28.9784 },
      'Europe/Warsaw': { lat: 52.2297, lng: 21.0122 },
      'Asia/Tokyo': { lat: 35.6762, lng: 139.65 }, 'Asia/Shanghai': { lat: 31.2304, lng: 121.4737 },
      'Asia/Kolkata': { lat: 19.076, lng: 72.8777 }, 'Asia/Dubai': { lat: 25.2048, lng: 55.2708 },
      'Asia/Seoul': { lat: 37.5665, lng: 126.978 }, 'Asia/Singapore': { lat: 1.3521, lng: 103.8198 },
      'Australia/Sydney': { lat: -33.8688, lng: 151.2093 }, 'Pacific/Auckland': { lat: -36.8485, lng: 174.7633 },
    };
    const gc = TZ_COORDS[profile.timezone] || TZ_COORDS['America/New_York'];
    const makePos = () => ({
      coords: { latitude: gc.lat + (prngNext() - 0.5) * 0.05, longitude: gc.lng + (prngNext() - 0.5) * 0.05, accuracy: 50 + prngInt(0, 100), altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now(),
    });
    navigator.geolocation.getCurrentPosition = function(s, e, o) { if (s) setTimeout(() => s(makePos()), 50 + prngInt(0, 100)); };
    navigator.geolocation.watchPosition = function(s, e, o) { if (s) { const id = setInterval(() => s(makePos()), 5000); return prngInt(1, 99999); } return prngInt(1, 99999); };

    // ── 10. MATCH MEDIA / PREFERENCES ──
    // v2.0.9: Also intercept device-width/device-height media queries to prevent CSS leak
    const origMatchMedia = window.matchMedia;
    const _sw = profile.screen.width, _sH = profile.screen.height;
    const _dwRe = /(?:min|max)-device-width\s*:\s*(\d+)/;
    const _dhRe = /(?:min|max)-device-height\s*:\s*(\d+)/;
    window.matchMedia = function(q) {
      // Rewrite device-width/device-height queries to use profile screen dimensions
      let rewritten = q;
      rewritten = rewritten.replace(_dwRe, function(m, val) {
        return m.replace(String(val), String(_sw));
      });
      rewritten = rewritten.replace(_dhRe, function(m, val) {
        return m.replace(String(val), String(_sH));
      });
      const r = origMatchMedia.call(this, rewritten);
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
        mql.onchange = null;
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
        instance.addEventListener = function(type, listener, ...args) { if (BLOCKED_EVENTS.has(type)) return; return origAddEventListener(type, listener, ...args); };
        const origRemoveEventListener = instance.removeEventListener.bind(instance);
        instance.removeEventListener = function(type, listener, ...args) { if (BLOCKED_EVENTS.has(type)) return; return origRemoveEventListener(type, listener, ...args); };
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
    // Whitelist approach: block everything except known browser-safe schemes.
    // Covers tg://, slack://, zoom://, magnet:, mailto:, tel:, and any other
    // custom scheme — current or future.
    const SAFE_PROTOCOLS = new Set([
      'http','https','about','javascript','data','blob','file',
      'ws','wss','chrome','chrome-extension','chrome-untrusted','devtools',
    ]);
    const _protoRe = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
    const isBlockedProtocol = function(url) {
      if (typeof url !== 'string') return false;
      var m = url.match(_protoRe);
      return m ? !SAFE_PROTOCOLS.has(m[1].toLowerCase()) : false;
    };

    // 14a. Block window.open() with custom protocols
    var origWindowOpen = window.open;
    window.open = function(url, target, features) {
      if (isBlockedProtocol(url)) return null;
      return origWindowOpen.call(this, url, target, features);
    };

    // 14b. Intercept clicks on <a href="tg://..."> etc.
    //     Browser handles these natively, not via window.open,
    //     so we catch at the capture phase of the click event.
    document.addEventListener('click', function(e) {
      var el = e.target.closest('a[href]');
      if (!el) return;
      var href = el.getAttribute('href');
      if (isBlockedProtocol(href)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    // 14c. Block location.assign / location.replace / location.href =
    var _origAssign = Location.prototype.assign;
    var _origReplace = Location.prototype.replace;
    Location.prototype.assign = function(url) { if (isBlockedProtocol(url)) return; return _origAssign.call(this, url); };
    Location.prototype.replace = function(url) { if (isBlockedProtocol(url)) return; return _origReplace.call(this, url); };
    try {
      var _hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      if (_hrefDesc && _hrefDesc.set) {
        var _origHrefSet = _hrefDesc.set;
        Object.defineProperty(Location.prototype, 'href', {
          ..._hrefDesc,
          set: function(v) { if (isBlockedProtocol(v)) return; return _origHrefSet.call(this, v); },
        });
      }
    } catch(e) {}

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
  // PROFILE LOADER ── Multiple delivery paths for iframe reliability
  // ═══════════════════════════════════════════════════════════════
  function onProfileReady() {
    if (_ready) return;
    _ready = true;
    _prngState = profile.seed | 0;
    // Re-seed the global PRNG used by canvas-hooks.js so canvas noise is deterministic
    if (_globalPrng) _globalPrng.setSeed(profile.seed | 0);
    console.log('[FPSync v2.0.9] Phase 2: Profile loaded, seed:', _prngState, 'at', performance.now().toFixed(1), 'ms', window !== window.top ? '[IFRAME]' : '[TOP]');
    installProfileHooks();
  }

  // ── Fallback: load profile directly from chrome.storage.local ──
  // Critical for iframes where MutationObserver may miss __fpsync_data element.
  // In MAIN world, chrome.storage.local is accessible (no web_accessible needed).
  function loadProfileFromStorage() {
    if (_ready) return;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([
          'fpsync_profile', 'fpsync_enabled',
          'fpsync_webrtc_block', 'fpsync_local_net_block', 'fpsync_protocol_block',
          'fpsync_link_cleaner', 'fpsync_link_cleaner_aggressive',
          'fpsync_link_cleaner_custom_params', 'fpsync_link_cleaner_custom_prefixes'
        ], function(data) {
          if (_ready) return;
          if (data.fpsync_enabled === false) return;
          if (!data.fpsync_profile) return;
          try {
            profile = typeof data.fpsync_profile === 'string' ? JSON.parse(data.fpsync_profile) : data.fpsync_profile;
            if (data.fpsync_webrtc_block !== undefined) fpSettings.webrtcBlock = data.fpsync_webrtc_block;
            if (data.fpsync_local_net_block !== undefined) fpSettings.localNetBlock = data.fpsync_local_net_block;
            if (data.fpsync_protocol_block !== undefined) fpSettings.protocolBlock = data.fpsync_protocol_block;
            if (data.fpsync_link_cleaner !== undefined) fpSettings.linkCleaner.enabled = data.fpsync_link_cleaner;
            if (data.fpsync_link_cleaner_aggressive) fpSettings.linkCleaner.aggressive = true;
            if (data.fpsync_link_cleaner_custom_params) fpSettings.linkCleaner.customParams = data.fpsync_link_cleaner_custom_params;
            if (data.fpsync_link_cleaner_custom_prefixes) fpSettings.linkCleaner.customPrefixes = data.fpsync_link_cleaner_custom_prefixes;
            console.log('[FPSync v2.0.9] Profile loaded from chrome.storage fallback', window !== window.top ? '[IFRAME]' : '[TOP]');
            onProfileReady();
          } catch(e) {
            console.warn('[FPSync v2.0.9] Storage fallback parse error:', e);
          }
        });
      }
    } catch(e) {
      // chrome.storage not available (e.g. about:blank without origin) ── silent
    }
  }

  // ── Path 1: __fpsync_data element already exists (fast path) ──
  const existingEl = document.getElementById('__fpsync_data');
  if (existingEl) {
    if (existingEl.getAttribute('data-skip') === '1') return;
    try { const raw = existingEl.getAttribute('data-profile'); if (raw) profile = JSON.parse(decodeURIComponent(raw)); } catch (e) {}
    try { const rawS = existingEl.getAttribute('data-settings'); if (rawS) fpSettings = JSON.parse(decodeURIComponent(rawS)); } catch (e) {}
    existingEl.remove();
    if (profile) {
      onProfileReady();
    } else {
      loadProfileFromStorage();
    }
  } else {
    // ── Path 2: MutationObserver watches for __fpsync_data ──
    let _observerDone = false;
    const observer = new MutationObserver((mutations, obs) => {
      const el = document.getElementById('__fpsync_data');
      if (!el) return;
      _observerDone = true;
      obs.disconnect();
      if (el.getAttribute('data-skip') === '1') return;
      try { const raw = el.getAttribute('data-profile'); if (raw) profile = JSON.parse(decodeURIComponent(raw)); } catch (e) {}
      try { const rawS = el.getAttribute('data-settings'); if (rawS) fpSettings = JSON.parse(decodeURIComponent(rawS)); } catch (e) {}
      el.remove();
      if (profile) onProfileReady();
      else loadProfileFromStorage();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // ── Path 3: If MutationObserver doesn't fire within 2s, try storage directly ──
    setTimeout(() => {
      if (_ready) return;
      if (!_observerDone) {
        observer.disconnect();
        loadProfileFromStorage();
      }
    }, 2000);

    // ── Path 4: For iframes created after document_start, retry on DOMContentLoaded ──
    if (document.readyState !== 'loading') {
      if (!_ready) loadProfileFromStorage();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        if (!_ready) loadProfileFromStorage();
      });
    }
  }

})();
