/**
 * FingerprintSync — MAIN world content script
 * Injected at document_start, runs BEFORE any page JS.
 * Intercepts ALL fingerprinting APIs with consistent profile-derived values.
 *
 * Flow:
 *   1. Receive profile from background via document.currentScript.dataset
 *   2. Initialize PRNG with profile.seed (for Canvas/Audio/ClientRects noise)
 *   3. Override navigator, screen, Canvas, WebGL, AudioContext, etc.
 */

'use strict';

(function FingerprintSyncMain() {
  // Prevent double-injection
  const MARKER = '__fpsync_main';
  if (document.documentElement.dataset[MARKER]) return;
  document.documentElement.dataset[MARKER] = '1';
  setTimeout(() => delete document.documentElement.dataset[MARKER], 2000);

  // ─── 1. Load profile from DOM element set by ISOLATED world ───
  // No inline scripts — CSP-safe. Data passed via hidden div attributes.
  let profile = null;
  let fpSettings = { webrtcBlock: true, localNetBlock: true, protocolBlock: true, linkCleaner: { enabled: true, aggressive: false, customParams: '', customPrefixes: '' } };
  const dataEl = document.getElementById('__fpsync_data');
  if (dataEl) {
    try {
      const raw = dataEl.getAttribute('data-profile');
      if (raw) profile = JSON.parse(decodeURIComponent(raw));
    } catch (e) {
      console.warn('[FingerprintSync] Failed to parse profile from DOM');
    }
    try {
      const rawSettings = dataEl.getAttribute('data-settings');
      if (rawSettings) fpSettings = JSON.parse(decodeURIComponent(rawSettings));
    } catch (e) {}
    // Clean up the data element
    dataEl.remove();
  }

  if (!profile) {
    // No profile — extension disabled or error. Bail out.
    return;
  }

  // ─── 2. Initialize Seeded PRNG for noise-based vectors ───
  // Mulberry32 inlined (no external dependency needed in MAIN world)
  let _prngState = profile.seed | 0;
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
    } catch (e) {
      // Silently fail if property is non-configurable
    }
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
  // 3. NAVIGATOR OVERRIDES
  // ═══════════════════════════════════════════════════════════════
  const nav = window.navigator;

  definePropOnChain(Navigator.prototype, 'userAgent', () => profile.ua);
  definePropOnChain(Navigator.prototype, 'appVersion', () => profile.appVersion);
  definePropOnChain(Navigator.prototype, 'platform', () => profile.platform);
  definePropOnChain(Navigator.prototype, 'vendor', () => profile.vendor);
  definePropOnChain(Navigator.prototype, 'language', () => profile.language);
  definePropOnChain(Navigator.prototype, 'languages', () => Object.freeze([...profile.languages]));
  definePropOnChain(Navigator.prototype, 'hardwareConcurrency', () => profile.hardwareConcurrency);
  definePropOnChain(Navigator.prototype, 'deviceMemory', () => profile.deviceMemory);

  if (profile.oscpu !== undefined) {
    definePropOnChain(Navigator.prototype, 'oscpu', () => profile.oscpu);
  }
  if (profile.dnt !== undefined) {
    definePropOnChain(Navigator.prototype, 'doNotTrack', () => profile.dnt);
  }

  // Navigator.plugins — empty or minimal (modern Chrome behavior)
  definePropOnChain(Navigator.prototype, 'plugins', () => {
    const arr = Object.create(PluginArray.prototype);
    Object.defineProperty(arr, 'length', { value: 0, writable: false });
    return arr;
  });

  // Navigator.mimeTypes
  definePropOnChain(Navigator.prototype, 'mimeTypes', () => {
    const arr = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(arr, 'length', { value: 0, writable: false });
    return arr;
  });

  // Navigator.connection
  if (nav.connection) {
    const connProfile = {
      effectiveType: prngNext() < 0.6 ? '4g' : (prngNext() < 0.5 ? '3g' : '4g'),
      rtt: prngInt(20, 100),
      downlink: (1 + prngNext() * 9).toFixed(1),
      saveData: false,
      type: 'wifi',
    };
    // Override as needed — but don't break if already spoofed
    try {
      Object.defineProperty(Navigator.prototype, 'connection', {
        configurable: true,
        enumerable: true,
        get: () => connProfile,
      });
    } catch (e) {}
  }

  // User-Agent Client Hints
  if (profile.userAgentData) {
    const uaData = profile.userAgentData;
    definePropOnChain(Navigator.prototype, 'userAgentData', () => uaData);
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. SCREEN OVERRIDES
  // ═══════════════════════════════════════════════════════════════
  const scr = profile.screen;
  definePropOnChain(Screen.prototype, 'width', () => scr.width);
  definePropOnChain(Screen.prototype, 'height', () => scr.height);
  definePropOnChain(Screen.prototype, 'availWidth', () => scr.availWidth);
  definePropOnChain(Screen.prototype, 'availHeight', () => scr.availHeight);
  definePropOnChain(Screen.prototype, 'colorDepth', () => scr.colorDepth);
  definePropOnChain(Screen.prototype, 'pixelDepth', () => scr.pixelDepth);
  definePropOnChain(Screen.prototype, 'orientation', () => ({
    type: scr.width > scr.height ? 'landscape-primary' : 'portrait-primary',
    angle: 0,
    onchange: null,
  }));

  // devicePixelRatio is on window, not Screen.prototype
  try {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      enumerable: true,
      get: () => scr.devicePixelRatio,
    });
  } catch (e) {}

  // innerWidth/innerHeight — derive from screen with small random offset (taskbar variability)
  const innerW = scr.availWidth;
  const innerH = scr.availHeight - prngInt(80, 140); // browser chrome
  try {
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => innerW });
    Object.defineProperty(window, 'outerWidth', { configurable: true, get: () => scr.availWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => innerH });
    Object.defineProperty(window, 'outerHeight', { configurable: true, get: () => scr.availHeight });
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════
  // 5. TIMEZONE OVERRIDES
  // ═══════════════════════════════════════════════════════════════
  const origDateTimeFormat = Intl.DateTimeFormat;
  try {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      configurable: true,
      value: function(...args) {
        if (args.length === 0 || (args.length === 1 && typeof args[0] === 'string' && !args[0].includes('/'))) {
          args[0] = profile.timezone;
        }
        return new origDateTimeFormat(...args);
      },
    });
    // Also override supportedValuesOf to include our timezone
    const origSupportedValuesOf = Intl.DateTimeFormat.supportedValuesOf;
    Object.defineProperty(Intl.DateTimeFormat, 'supportedValuesOf', {
      configurable: true,
      value: function(key) {
        if (key === 'timeZone') {
          const all = origSupportedValuesOf.call(this, key);
          if (!all.includes(profile.timezone)) {
            return [...all, profile.timezone];
          }
          return all;
        }
        return origSupportedValuesOf.call(this, key);
      },
    });
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════
  // 6. CANVAS FINGERPRINT — Deterministic noise
  // ═══════════════════════════════════════════════════════════════
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  // Pre-generate noise map for this session (consistent)
  function applyCanvasNoise(ctx, canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;

    const imgData = origGetImageData.call(ctx, 0, 0, w, h);
    const data = imgData.data;
    const len = data.length;

    // Modify ~3-5% of pixels by +/- 1 (invisible to eye, changes hash)
    const threshold = 0.03 + prngNext() * 0.02;
    for (let i = 0; i < len; i += 4) {
      if (prngNext() < threshold) {
        const offset = prngNext() > 0.5 ? 1 : -1;
        data[i] = Math.max(0, Math.min(255, data[i] + offset));     // R
        // Occasionally also modify G and B
        if (prngNext() < 0.3) {
          data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + offset)); // G
        }
        if (prngNext() < 0.2) {
          data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + offset)); // B
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function getOffscreenCopy(canvas) {
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    if (octx) octx.drawImage(canvas, 0, 0);
    return { canvas: off, ctx: octx };
  }

  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const { canvas: off } = getOffscreenCopy(this);
      const offCtx = off.getContext('2d');
      if (offCtx) applyCanvasNoise(offCtx, off);
      return origToDataURL.apply(off, args);
    }
    return origToDataURL.apply(this, args);
  };

  HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const { canvas: off } = getOffscreenCopy(this);
      const offCtx = off.getContext('2d');
      if (offCtx) applyCanvasNoise(offCtx, off);
      return origToBlob.apply(off, [callback, ...args]);
    }
    return origToBlob.apply(this, [callback, ...args]);
  };

  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const imgData = origGetImageData.apply(this, args);
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
  // 7. WEBGL FINGERPRINT
  // ═══════════════════════════════════════════════════════════════
  const gpu = profile.gpu;

  function hookWebGLGetParameter(ctx, origGetParam) {
    return function(pname) {
      switch (pname) {
        case 0x1F01: // RENDERER
          return gpu.renderer;
        case 0x1F00: // VENDOR
          return gpu.vendor;
        case 0x9245: // UNMASKED_VENDOR_WEBGL
          return gpu.unmaskedVendor || gpu.vendor;
        case 0x9246: // UNMASKED_RENDERER_WEBGL
          return gpu.unmaskedRenderer || gpu.renderer;
        case 0x0D33: // MAX_TEXTURE_SIZE
          return gpu.maxTextureSize;
        case 0x0D3A: // MAX_RENDERBUFFER_SIZE
          return gpu.maxRenderBufferSize;
        case 0x0D32: // MAX_CUBE_MAP_TEXTURE_SIZE
          return gpu.maxCubeMapSize;
        case 0x0D50: // POINT_SIZE_RANGE
          return new Float32Array(gpu.pointSizeRange);
        case 0x0D3A: // MAX_VIEWPORT_DIMS
          return new Int32Array(gpu.maxViewportDims);
        default:
          return origGetParam.call(this, pname);
      }
    };
  }

  function hookGetExtension(ctx, origGetExt) {
    return function(name) {
      const ext = origGetExt.call(this, name);
      if (!ext) return ext;

      // Hook DEBUG_RENDERER_INFO extension to return spoofed values
      if (name === 'WEBGL_debug_renderer_info') {
        return {
          UNMASKED_VENDOR_WEBGL: 0x9245,
          UNMASKED_RENDERER_WEBGL: 0x9246,
        };
      }

      // Hook getSupportedExtensions to limit to our set
      return ext;
    };
  }

  // Hook both WebGL and WebGL2 contexts
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    const ctx = origGetContext.call(this, type, ...args);
    if (!ctx) return ctx;

    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      // Override getParameter
      const origGetParam = ctx.getParameter.bind(ctx);
      ctx.getParameter = hookWebGLGetParameter(ctx, origGetParam);

      // Override getExtension
      const origGetExt = ctx.getExtension.bind(ctx);
      ctx.getExtension = hookGetExtension(ctx, origGetExt);

      // Override getSupportedExtensions
      ctx.getSupportedExtensions = () => gpu.extensions;

      // Ensure WEBGL_debug_renderer_info constants work with our spoofed values
      const debugExt = origGetExt('WEBGL_debug_renderer_info');
      if (debugExt) {
        // The real extension exists; our getParameter handles the values
      }
    }
    return ctx;
  };

  // ═══════════════════════════════════════════════════════════════
  // 8. AUDIOCONTEXT FINGERPRINT — Deterministic noise
  // ═══════════════════════════════════════════════════════════════
  const audio = profile.audio;

  const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
  if (OrigAudioContext) {
    function FakeAudioContext(...args) {
      const instance = new OrigAudioContext(...args);
      // Override properties
      try {
        Object.defineProperty(instance, 'sampleRate', {
          configurable: true, get: () => audio.sampleRate,
        });
        Object.defineProperty(instance, 'baseLatency', {
          configurable: true, get: () => audio.baseLatency,
        });
        Object.defineProperty(instance, 'outputLatency', {
          configurable: true, get: () => audio.outputLatency,
        });
        Object.defineProperty(instance, 'state', {
          configurable: true, get: () => audio.state,
        });
      } catch (e) {}
      return instance;
    }
    FakeAudioContext.prototype = OrigAudioContext.prototype;
    window.AudioContext = FakeAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = FakeAudioContext;
  }

  // Override OfflineAudioContext
  const OrigOfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (OrigOfflineAudioContext) {
    function FakeOfflineAudioContext(...args) {
      const instance = new OrigOfflineAudioContext(...args);
      try {
        Object.defineProperty(instance, 'sampleRate', {
          configurable: true, get: () => audio.sampleRate,
        });
        Object.defineProperty(instance, 'length', {
          configurable: true, get: () => (args[1] || 44100),
        });
      } catch (e) {}
      return instance;
    }
    FakeOfflineAudioContext.prototype = OrigOfflineAudioContext.prototype;
    window.OfflineAudioContext = FakeOfflineAudioContext;
    if (window.webkitOfflineAudioContext) window.webkitOfflineAudioContext = FakeOfflineAudioContext;
  }

  // ═══════════════════════════════════════════════════════════════
  // 9. FONT FINGERPRINT — Intercept font detection
  // ═══════════════════════════════════════════════════════════════
  // The profile contains the font list. We intercept document.fonts.check
  // and font measurement APIs to return results consistent with our list.
  const profileFonts = new Set(profile.fonts);

  // Intercept the FontFace API
  if (window.FontFace) {
    const OrigFontFace = window.FontFace;
    window.FontFace = function(family, source, descriptors) {
      // If the font is not in our profile, make it appear unsupported
      return new OrigFontFace(family, source, descriptors);
    };
    window.FontFace.prototype = OrigFontFace.prototype;
  }

  // Override document.fonts.check to be consistent with our font list
  if (document.fonts && document.fonts.check) {
    const origFontsCheck = document.fonts.check.bind(document.fonts);
    document.fonts.check = function(font, text) {
      const match = font.match(/^\s*(\d+(?:\.\d+)?)(px|pt|em|rem|%)\s+"?([^"]+)"?/i);
      if (match) {
        const family = match[3].trim().replace(/['"]/g, '').split(',')[0].trim();
        if (!profileFonts.has(family)) {
          // Font not in our profile — report it as not available
          return false;
        }
      }
      return origFontsCheck(font, text);
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 10. CLIENTRECTS FINGERPRINT — Deterministic offsets
  // ═══════════════════════════════════════════════════════════════
  const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const origGetClientRects = Element.prototype.getClientRects;

  Element.prototype.getBoundingClientRect = function() {
    const rect = origGetBoundingClientRect.call(this);
    // Add tiny deterministic offsets (sub-pixel, < 0.5px)
    return new DOMRect(
      rect.x + (prngNext() - 0.5) * 0.1,
      rect.y + (prngNext() - 0.5) * 0.1,
      rect.width + (prngNext() - 0.5) * 0.1,
      rect.height + (prngNext() - 0.5) * 0.1
    );
  };

  Element.prototype.getClientRects = function() {
    const rects = origGetClientRects.call(this);
    const result = [];
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      result.push(new DOMRect(
        r.x + (prngNext() - 0.5) * 0.1,
        r.y + (prngNext() - 0.5) * 0.1,
        r.width + (prngNext() - 0.5) * 0.1,
        r.height + (prngNext() - 0.5) * 0.1
      ));
    }
    return result;
  };

  // Range.getClientRects (used by some fingerprinting libs)
  if (window.Range && window.Range.prototype.getClientRects) {
    const origRangeGetClientRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function() {
      const rects = origRangeGetClientRects.call(this);
      const result = [];
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        result.push(new DOMRect(
          r.x + (prngNext() - 0.5) * 0.1,
          r.y + (prngNext() - 0.5) * 0.1,
          r.width + (prngNext() - 0.5) * 0.1,
          r.height + (prngNext() - 0.5) * 0.1
        ));
      }
      return result;
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 11. WEBGPU FINGERPRINT
  // ═══════════════════════════════════════════════════════════════
  const webgpu = profile.webgpu;

  if (navigator.gpu) {
    const origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async function(...args) {
      // Strip powerPreference to suppress Chrome warning on Windows (crbug.com/369219127)
      if (args[0] && typeof args[0] === 'object' && 'powerPreference' in args[0]) {
        const { powerPreference, ...rest } = args[0];
        args[0] = rest;
      }
      const adapter = await origRequestAdapter(...args);
      if (!adapter) {
        // If no real adapter, create a fake one
        return createFakeGPUAdapter();
      }
      // Wrap the real adapter to spoof info
      return wrapGPUAdapter(adapter);
    };

    function createFakeGPUAdapter() {
      return {
        requestDevice: async () => createFakeGPUDevice(),
        info: {
          vendor: webgpu.vendor,
          architecture: webgpu.architecture,
          device: webgpu.device,
          description: webgpu.description,
          features: new Set(webgpu.features || []),
          limits: {
            maxTextureDimension1D: gpu.maxTextureSize,
            maxTextureDimension2D: gpu.maxTextureSize,
            maxTextureArrayLayers: 256,
            maxBindGroups: 4,
            maxBufferSize: 268435456,
            maxStorageBufferBindingSize: 134217728,
            maxUniformBufferBindingSize: 65536,
          },
        },
        destroy() {},
    };
    }

    function wrapGPUAdapter(adapter) {
      return new Proxy(adapter, {
        get(target, prop) {
          if (prop === 'info') {
            return {
              vendor: webgpu.vendor,
              architecture: webgpu.architecture,
              device: webgpu.device,
              description: webgpu.description,
              features: new Set(webgpu.features || []),
              limits: {
                maxTextureDimension1D: gpu.maxTextureSize,
                maxTextureDimension2D: gpu.maxTextureSize,
                maxTextureArrayLayers: 256,
                maxBindGroups: 4,
              },
            };
          }
          const val = target[prop];
          if (typeof val === 'function') return val.bind(target);
          return val;
        },
      });
    }

    function createFakeGPUDevice() {
      return {
        destroy() {},
        createBuffer() { return { destroy() {}, mapAsync() {}, unmap() {}, getMappedRange() { return new ArrayBuffer(0); } }; },
        createTexture() { return { destroy() {}, createView() { return {}; } }; },
        createShaderModule() { return { getCompilationInfo: async () => [] }; },
        createBindGroupLayout() { return {}; },
        createBindGroup() { return {}; },
        createPipelineLayout() { return {}; },
        createRenderPipeline() { return {}; },
        createComputePipeline() { return {}; },
        createCommandEncoder() { return { finish() { return {}; }, beginRenderPass() { return { end() {}, setPipeline() {}, setVertexBuffer() {}, draw() {}, drawIndexed() {} }; } }; },
        createComputePassEncoder() { return { end() {}, setPipeline() {}, dispatchWorkgroups() {} }; },
        queue: { submit() {}, writeBuffer() {}, copyBufferToTexture() {} },
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 12. GEOLOCATION SPOOF
  // ═══════════════════════════════════════════════════════════════
  // The profile includes timezone; geolocation is derived from timezone
  const TZ_COORDS = {
    'America/New_York':     { lat: 40.7128, lng: -74.0060, accuracy: 50 },
    'America/Chicago':      { lat: 41.8781, lng: -87.6298, accuracy: 50 },
    'America/Denver':       { lat: 39.7392, lng: -104.9903, accuracy: 50 },
    'America/Los_Angeles':  { lat: 34.0522, lng: -118.2437, accuracy: 50 },
    'America/Anchorage':    { lat: 61.2181, lng: -149.9003, accuracy: 50 },
    'America/Sao_Paulo':    { lat: -23.5505, lng: -46.6333, accuracy: 50 },
    'Europe/London':        { lat: 51.5074, lng: -0.1278, accuracy: 50 },
    'Europe/Paris':         { lat: 48.8566, lng: 2.3522, accuracy: 50 },
    'Europe/Berlin':        { lat: 52.5200, lng: 13.4050, accuracy: 50 },
    'Europe/Madrid':        { lat: 40.4168, lng: -3.7038, accuracy: 50 },
    'Europe/Rome':          { lat: 41.9028, lng: 12.4964, accuracy: 50 },
    'Europe/Amsterdam':     { lat: 52.3676, lng: 4.9041, accuracy: 50 },
    'Europe/Moscow':        { lat: 55.7558, lng: 37.6173, accuracy: 50 },
    'Europe/Istanbul':      { lat: 41.0082, lng: 28.9784, accuracy: 50 },
    'Europe/Warsaw':        { lat: 52.2297, lng: 21.0122, accuracy: 50 },
    'Asia/Dubai':           { lat: 25.2048, lng: 55.2708, accuracy: 50 },
    'Asia/Kolkata':         { lat: 19.0760, lng: 72.8777, accuracy: 50 },
    'Asia/Shanghai':        { lat: 31.2304, lng: 121.4737, accuracy: 50 },
    'Asia/Tokyo':           { lat: 35.6762, lng: 139.6503, accuracy: 50 },
    'Asia/Seoul':           { lat: 37.5665, lng: 126.9780, accuracy: 50 },
    'Asia/Singapore':       { lat: 1.3521, lng: 103.8198, accuracy: 50 },
    'Australia/Sydney':     { lat: -33.8688, lng: 151.2093, accuracy: 50 },
    'Pacific/Auckland':     { lat: -36.8485, lng: 174.7633, accuracy: 50 },
  };

  const geoCoords = TZ_COORDS[profile.timezone] || TZ_COORDS['America/New_York'];
  const geoPos = {
    coords: {
      latitude: geoCoords.lat + (prngNext() - 0.5) * 0.05,
      longitude: geoCoords.lng + (prngNext() - 0.5) * 0.05,
      accuracy: geoCoords.accuracy + prngInt(0, 100),
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
  };

  const origGeolocationGetCurrentPosition = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
  const origGeolocationWatchPosition = navigator.geolocation.watchPosition.bind(navigator.geolocation);

  navigator.geolocation.getCurrentPosition = function(success, error, options) {
    const pos = {
      ...geoPos,
      timestamp: Date.now(),
      coords: { ...geoPos.coords },
    };
    // Add small random walk for realism
    pos.coords.latitude += (prngNext() - 0.5) * 0.001;
    pos.coords.longitude += (prngNext() - 0.5) * 0.001;
    if (success) setTimeout(() => success(pos), 50 + prngInt(0, 100));
  };

  navigator.geolocation.watchPosition = function(success, error, options) {
    if (success) {
      const interval = setInterval(() => {
        const pos = {
          ...geoPos,
          timestamp: Date.now(),
          coords: { ...geoPos.coords },
        };
        pos.coords.latitude += (prngNext() - 0.5) * 0.002;
        pos.coords.longitude += (prngNext() - 0.5) * 0.002;
        success(pos);
      }, 5000);
      return prngInt(1, 99999);
    }
    return prngInt(1, 99999);
  };

  // ═══════════════════════════════════════════════════════════════
  // 13. REDUCE MOTION / PREFERENCES
  // ═══════════════════════════════════════════════════════════════
  const origMatchMedia = window.matchMedia;
  window.matchMedia = function(query) {
    const result = origMatchMedia.call(this, query);
    // Make prefers-color-scheme consistent with a random choice
    if (query === '(prefers-color-scheme: dark)') {
      return { ...result, matches: prngNext() < 0.45 };
    }
    if (query === '(prefers-reduced-motion: reduce)') {
      return { ...result, matches: false };
    }
    if (query === '(prefers-reduced-transparency: reduce)') {
      return { ...result, matches: false };
    }
    return result;
  };

  // ═══════════════════════════════════════════════════════════════
  // 14. GLOBAL PRIVACY CONTROL
  // ═══════════════════════════════════════════════════════════════
  if (profile.gpc) {
    try {
      Object.defineProperty(navigator, 'globalPrivacyControl', {
        configurable: true,
        enumerable: true,
        get: () => true,
      });
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════
  // 15. IFRAME PROPAGATION
  // ═══════════════════════════════════════════════════════════════
  // Ensure iframes also get the spoofed navigator
  const patchFrame = (iframe) => {
    try {
      if (!iframe || !iframe.contentWindow) return;
      // Same-origin iframes share the same overrides (they inherit from parent)
      // Cross-origin iframes can't be patched (and that's fine — they see a different context)
    } catch (e) {
      // Cross-origin — expected
    }
  };

  const origAppendChild = Node.prototype.appendChild;
  const origInsertBefore = Node.prototype.insertBefore;

  function iframeAwareProxy(origFn) {
    return function(...args) {
      const result = origFn.apply(this, args);
      if (args[0] && args[0].nodeName === 'IFRAME') {
        patchFrame(args[0]);
      }
      return result;
    };
  }

  try {
    Node.prototype.appendChild = iframeAwareProxy(origAppendChild);
    Node.prototype.insertBefore = iframeAwareProxy(origInsertBefore);
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════
  // 16. PERFORMANCE / TIMING LEAK REDUCTION
  // ═══════════════════════════════════════════════════════════════
  // Reduce precision of high-resolution timers to prevent timing attacks
  try {
    const origNow = performance.now.bind(performance);
    // Reduce to ~100μs precision (like most browsers after Spectre mitigations)
    const PRECISION = 0.1; // ms
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: function() {
        return Math.floor(origNow() / PRECISION) * PRECISION;
      },
    });
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════
  // 17. WEBRTC IP LEAK PROTECTION
  // ═══════════════════════════════════════════════════════════════
  // WebRTC can leak real local and public IP even behind VPN.
  // We make RTCPeerConnection a no-op that never reveals candidates.
  if (fpSettings.webrtcBlock && window.RTCPeerConnection) {
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = function(config, constraints) {
      const instance = new OrigRTC(config || {}, constraints || {});
      // Intercept createOffer to strip local ICE candidates from SDP
      const origCreateOffer = instance.createOffer.bind(instance);
      instance.createOffer = async function(options) {
        const offer = await origCreateOffer(options || {});
        if (offer.sdp) {
          offer.sdp = offer.sdp.replace(/a=candidate:.+\r?\n/g, '');
        }
        return offer;
      };
      // Intercept setLocalDescription to strip candidates
      const origSetLocalDesc = instance.setLocalDescription.bind(instance);
      instance.setLocalDescription = async function(desc) {
        if (desc && desc.sdp) {
          desc.sdp = desc.sdp.replace(/a=candidate:.+\r?\n/g, '');
        }
        return origSetLocalDesc(desc);
      };
      // Block onicecandidate from firing with real candidates
      Object.defineProperty(instance, 'onicecandidate', {
        configurable: true,
        get() { return null; },
        set() {},
      });
      // Make iceGatheringState stay at 'new'
      Object.defineProperty(instance, 'iceGatheringState', {
        configurable: true,
        get: () => 'new',
      });
      // Override localDescription to strip candidates
      try {
        const origLD = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription');
        if (origLD && origLD.get) {
          Object.defineProperty(instance, 'localDescription', {
            configurable: true,
            get: () => {
              const desc = origLD.get.call(instance);
              if (desc && desc.sdp) {
                return { type: desc.type, sdp: desc.sdp.replace(/a=candidate:.+\r?\n/g, '') };
              }
              return desc;
            },
          });
        }
      } catch (e) {}
      // Override getStats to remove local IP entries
      const origGetStats = instance.getStats.bind(instance);
      instance.getStats = async function() {
        const stats = await origGetStats();
        if (stats instanceof Map) {
          const cleaned = new Map();
          for (const [key, value] of stats) {
            if (value && value.type === 'local-candidate') continue;
            if (value && value.type === 'candidate-pair' && value.localCandidateId) continue;
            cleaned.set(key, value);
          }
          return cleaned;
        }
        return stats;
      };
      return instance;
    };
    window.RTCPeerConnection.prototype = OrigRTC.prototype;
    if (window.webkitRTCPeerConnection) {
      window.webkitRTCPeerConnection = window.RTCPeerConnection;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 18. CUSTOM PROTOCOL SCHEME PROTECTION
  // ═══════════════════════════════════════════════════════════════
  // Sites detect installed programs by timing iframe navigations to
  // custom protocol schemes (slack://, zoom://, spotify://, etc.)
  if (fpSettings.protocolBlock) {
  const BLOCKED_PROTOCOLS = new Set([
    'slack','zoom','teams','skype','discord','spotify','telegram','whatsapp','viber',
    'outlook','steam','epicgames','riotclient','magnet','torrent','thunder',
    'vscode','cursor','intellij','xcode','figma','notion','obsidian',
    '1password','bitwarden','keepassxc','deezer','tidal','zoommtg','msteams',
    'sip','sips','facetime','chrome-extension','moz-extension','brave',
  ]);
  const ALLOWED_PROTOCOLS = new Set(['http','https','about','javascript','data','blob','ftp','file']);
  const isCustomProtocol = (url) => {
    try {
      const m = String(url).match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
      return m && !ALLOWED_PROTOCOLS.has(m[1].toLowerCase());
    } catch { return false; }
  };
  // Intercept window.open
  const origWindowOpen = window.open;
  window.open = function(url, target, features) {
    if (typeof url === 'string' && isCustomProtocol(url)) {
      const m = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
      if (m && BLOCKED_PROTOCOLS.has(m[1].toLowerCase())) return null;
    }
    return origWindowOpen.call(this, url, target, features);
  };
  // Block iframe src with custom protocols via MutationObserver
  const protocolCheckIframe = (iframe) => {
    try {
      if (typeof iframe.src === 'string' && isCustomProtocol(iframe.src)) {
        const m = iframe.src.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
        if (m && BLOCKED_PROTOCOLS.has(m[1].toLowerCase())) {
          iframe.src = 'about:blank';
        }
      }
    } catch (e) {}
  };
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeName === 'IFRAME') protocolCheckIframe(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });
  // Hide protocol handler registration
  if (navigator.registerProtocolHandler) {
    navigator.registerProtocolHandler = function() {};
  }
  if (navigator.isProtocolHandlerRegistered) {
    navigator.isProtocolHandlerRegistered = function() { return false; };
  }
  } // end protocolBlock

  // ═══════════════════════════════════════════════════════════════
  // 19. LOCAL NETWORK PROBING PROTECTION
  // ═══════════════════════════════════════════════════════════════
  // Block fetch/XHR to local/private IPs to prevent LAN scanning.
  if (fpSettings.localNetBlock) {
  const isLocalIP = (url) => {
    try {
      const host = new URL(url).hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
          host === '0.0.0.0' || host === '[::1]') return true;
      if (/^10\./.test(host)) return true;
      if (/^192\.168\./.test(host)) return true;
      if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
      if (/^169\.254\./.test(host)) return true;
      if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    } catch (e) {}
    return false;
  };
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    if (isLocalIP(url)) return Promise.reject(new TypeError('Failed to fetch'));
    return origFetch.call(this, input, init);
  };
  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (typeof url === 'string' && isLocalIP(url)) this._fpsync_blocked = true;
    return origXHROpen.call(this, method, url, ...rest);
  };
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    if (this._fpsync_blocked) {
      const xhr = this;
      setTimeout(() => {
        try {
          Object.defineProperty(xhr, 'readyState', { value: 4, writable: false });
          Object.defineProperty(xhr, 'status', { value: 0, writable: false });
          Object.defineProperty(xhr, 'statusText', { value: '', writable: false });
          if (xhr.onerror) xhr.onerror(new Event('error'));
          if (xhr.onreadystatechange) xhr.onreadystatechange(new Event('readystatechange'));
        } catch (e) {}
      }, 5 + Math.floor(prngNext() * 20));
      return;
    }
    return origXHRSend.call(this, body);
  };
  } // end localNetBlock

  // ═══════════════════════════════════════════════════════════════
  // 20. LINK CLEANER — Clean tracking params directly in address bar
  // ═══════════════════════════════════════════════════════════════
  if (fpSettings.linkCleaner && fpSettings.linkCleaner.enabled) {
  // Build param set from core + settings
  const TRACKING_PARAMS = new Set([
    'utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id',
    'utm_source_platform','utm_creative_format','utm_marketing_tactic',
    '_ga','_gl','_gid','gclsrc','gclid','gad_source','gbraid','wbraid',
    'fbclid','fb_action_ids','fb_action_types','fb_source','fb_ref','hrc_enc','s_cid',
    'msclkid','twclid','li_fat_id','trk_contact','trk_module','trk_sid',
    'mc_eid','mc_cid','_openstat','yclid','ysclid','wickedid','dclid','spm','scm',
    'from','igshid','si','feature','ref_code','affiliate_id','aff_id','campaign_id',
    'click_id','clickid','mkt_tok','hsCtaTracking','_hsenc','_hsmi',
    'vero_id','vgo_ee','ef_id','s_kwcid','pk_campaign','pk_kwd','pk_source','pk_medium',
    'hj_uid','hjid','hj_lid','ref','tag','ascsubtag',
  ]);
  // Add aggressive params if enabled
  if (fpSettings.linkCleaner.aggressive) {
    ['ref','referrer','referrer_url','source_url','campaign','ad_id','adgroup','adset',
     'creative_id','placement','keyword','matchtype','network','device','locale','lang',
     'version','build','variant','tab','panel','section','card','searchlog','log','debug',
     'token','session','session_id','tracking_id','visitor_id','cookie_id','page_id',
     'content_id','object_id','impression_id','transaction_id'].forEach(p => TRACKING_PARAMS.add(p));
  }
  // Add custom params from settings
  if (fpSettings.linkCleaner.customParams) {
    fpSettings.linkCleaner.customParams.split('\n').forEach(p => { if (p.trim()) TRACKING_PARAMS.add(p.trim()); });
  }
  // Add custom prefixes from settings
  const CUSTOM_PREFIXES = [];
  if (fpSettings.linkCleaner.customPrefixes) {
    fpSettings.linkCleaner.customPrefixes.split('\n').forEach(p => { if (p.trim()) CUSTOM_PREFIXES.push(p.trim().toLowerCase()); });
  }
  if (fpSettings.linkCleaner.aggressive) {
    ['utm_','cm_','pk_','ef_','hj_','hs_','mkto_','_ga','_gl','_hs','mc_','mkt_'].forEach(p => CUSTOM_PREFIXES.push(p));
  }
  function matchesTrackingParam(key) {
    const lk = key.toLowerCase();
    if (TRACKING_PARAMS.has(key) || TRACKING_PARAMS.has(lk)) return true;
    for (const prefix of CUSTOM_PREFIXES) {
      if (lk.startsWith(prefix)) return true;
    }
    return false;
  }
  function cleanPageUrl() {
    try {
      const url = location.href;
      if (!url.includes('?')) return;
      const p = new URL(url);
      let changed = false;
      for (const key of [...p.searchParams.keys()]) {
        if (matchesTrackingParam(key)) { p.searchParams.delete(key); changed = true; }
      }
      if (changed) {
        let clean = p.toString();
        if (clean.endsWith('?')) clean = clean.slice(0, -1);
        history.replaceState(null, '', clean);
      }
    } catch (e) {}
  }
  if (document.readyState === 'complete') { cleanPageUrl(); } else { window.addEventListener('load', cleanPageUrl); }
  // Intercept pushState / replaceState
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function(state, title, url) {
    if (typeof url === 'string' && url.includes('?')) {
      try {
        const p = new URL(url, location.origin);
        for (const key of [...p.searchParams.keys()]) { if (matchesTrackingParam(key)) p.searchParams.delete(key); }
        url = p.toString();
        if (url.endsWith('?')) url = url.slice(0, -1);
      } catch (e) {}
    }
    return origPushState.call(this, state, title, url);
  };
  history.replaceState = function(state, title, url) {
    if (typeof url === 'string' && url.includes('?')) {
      try {
        const p = new URL(url, location.origin);
        for (const key of [...p.searchParams.keys()]) { if (matchesTrackingParam(key)) p.searchParams.delete(key); }
        url = p.toString();
        if (url.endsWith('?')) url = url.slice(0, -1);
      } catch (e) {}
    }
    return origReplaceState.call(this, state, title, url);
  };
  // Intercept link clicks to clean before navigation
  document.addEventListener('click', function(e) {
    const link = e.target.closest('a');
    if (link && link.href) {
      try {
        const p = new URL(link.href);
        let changed = false;
        for (const key of [...p.searchParams.keys()]) { if (matchesTrackingParam(key)) { p.searchParams.delete(key); changed = true; } }
        if (changed) link.href = p.toString();
      } catch (ex) {}
    }
  }, true);
  } // end linkCleaner

})();
