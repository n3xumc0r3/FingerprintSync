/**
 * Profile Engine — generates a complete, self-consistent browser fingerprint profile
 * from a single 32-bit seed.
 *
 * Every vector (UA, Canvas noise, WebGL, Audio, Fonts, ClientRects, WebGPU, Screen)
 * is derived from the SAME seed, so everything is consistent within a session.
 */

// These will be set by the host (background.js or content script bootstrap)
/* global SeededPRNG, GPU_DATABASE, getFontsForOS */

class ProfileEngine {
  constructor(seed) {
    this.seed = seed;
    this.rng = new SeededPRNG(seed);
    this.profile = this._generate();
  }

  _generate() {
    const r = this.rng;

    // 1. Pick OS (weighted: windows is most common for Chrome)
    const osRoll = r.next();
    const os = osRoll < 0.55 ? 'windows' : osRoll < 0.80 ? 'macos' : 'linux';

    // 2. Pick GPU (must match OS)
    const gpuList = GPU_DATABASE[os];
    const gpu = r.pick(gpuList);

    // 3. hardwareConcurrency and deviceMemory — constrained by GPU
    const hardwareConcurrency = r.pick(gpu.hardwareConcurrency);
    const deviceMemory = r.pick(gpu.deviceMemory);

    // 4. Screen resolution (must be realistic for OS/GPU tier)
    const screen = this._genScreen(os, gpu, r);

    // 5. User-Agent, platform, vendor
    const chromeVer = r.nextInt(125, 131);
    const { ua, platform, appVersion, oscpu, userAgentData } = this._genUA(os, chromeVer, r);

    // 6. Language (weighted toward English, but with variation)
    const { language, languages } = this._genLanguage(r);

    // 7. Timezone (weighted toward common ones)
    const timezone = this._genTimezone(r);

    // 8. Fonts (OS-consistent)
    const fonts = getFontsForOS(os, r);

    // 9. AudioContext params
    const audio = this._genAudio(r);

    // 10. WebGPU adapter info (derived from WebGL GPU)
    const webgpu = this._genWebGPU(gpu, os, r);

    // 11. Do Not Track / Global Privacy Control
    const dnt = r.chance(0.15) ? '1' : null;
    const gpc = r.chance(0.10);

    return {
      os,
      ua,
      platform,
      appVersion,
      oscpu,
      userAgentData,
      vendor: 'Google Inc.',
      hardwareConcurrency,
      deviceMemory,
      screen,
      language,
      languages,
      timezone,
      gpu: {
        vendor: gpu.vendor,
        renderer: gpu.renderer,
        unmaskedVendor: gpu.unmaskedVendor,
        unmaskedRenderer: gpu.unmaskedRenderer,
        extensions: gpu.extensions,
        maxTextureSize: gpu.maxTextureSize,
        maxRenderBufferSize: gpu.maxRenderBufferSize,
        maxViewportDims: gpu.maxViewportDims,
        maxCubeMapSize: gpu.maxCubeMapSize,
        pointSizeRange: gpu.pointSizeRange,
      },
      fonts,
      audio,
      webgpu,
      dnt,
      gpc,
      seed: this.seed,
    };
  }

  _genScreen(os, gpu, r) {
    // Common resolutions by OS
    const resolutions = {
      windows: [
        [1920, 1080], [2560, 1440], [1366, 768], [1536, 864],
        [1440, 900], [2560, 1080], [3840, 2160], [1600, 900],
      ],
      macos: [
        [2560, 1440], [3024, 1964], [2560, 1600], [2880, 1800],
        [1680, 1050], [1440, 900], [5120, 2880],
      ],
      linux: [
        [1920, 1080], [2560, 1440], [3840, 2160], [1366, 768],
        [1680, 1050], [1600, 900], [2560, 1080],
      ],
    };
    const [w, h] = r.pick(resolutions[os]);
    const dpr = r.pick([1, 1, 1, 1.25, 1.5, 1.5, 2]); // 1x most common
    return {
      width: w,
      height: h,
      availWidth: w,
      availHeight: h - r.nextInt(30, 48), // taskbar
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: dpr,
    };
  }

  _genUA(os, chromeVer, r) {
    const platformMap = { windows: 'Win32', macos: 'MacIntel', linux: 'Linux x86_64' };
    const oscpuMap = { windows: undefined, macos: undefined, linux: undefined };
    const platform = platformMap[os];

    // Windows version tokens
    const winTokens = ['10.0', '10.0', '10.0', '10.0', '11.0']; // 10.0 more common
    const winVer = r.pick(winTokens);

    const templates = {
      windows: `Mozilla/5.0 (Windows NT ${winVer}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer}.0.0.0 Safari/537.36`,
      macos: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer}.0.0.0 Safari/537.36`,
      linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer}.0.0.0 Safari/537.36`,
    };

    const ua = templates[os];
    const appVersion = ua.replace('Mozilla/', '');

    // Client Hints (User-Agent Data)
    const platformNames = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
    const brands = [
      { brand: 'Not A(Brand', version: '99' },
      { brand: 'Google Chrome', version: String(chromeVer) },
      { brand: 'Chromium', version: String(chromeVer) },
    ];

    const userAgentData = {
      brands,
      mobile: false,
      platform: platformNames[os],
      getHighEntropyValues: async () => ({
        brands: [
          { brand: 'Not A(Brand', version: '99.0.0.0' },
          { brand: 'Google Chrome', version: `${chromeVer}.0.${r.nextInt(6300,6800)}.${r.nextInt(50,200)}` },
          { brand: 'Chromium', version: `${chromeVer}.0.${r.nextInt(6300,6800)}.${r.nextInt(50,200)}` },
        ],
        fullVersionList: brands, // populated dynamically
        mobile: false,
        platform: platformNames[os],
        platformVersion: os === 'windows' ? `${winVer}.0` : (os === 'macos' ? '14.7.0' : '6.8.0'),
        architecture: 'x86',
        bitness: '64',
        model: '',
        uaFullVersion: `${chromeVer}.0.0.0`,
      }),
      toJSON() { return { brands, mobile: false, platform: platformNames[os] }; },
    };

    return { ua, platform, appVersion, oscpu: oscpuMap[os], userAgentData };
  }

  _genLanguage(r) {
    const langOptions = [
      { lang: 'en-US', langs: ['en-US', 'en'] },
      { lang: 'en-US', langs: ['en-US', 'en', 'de'] },
      { lang: 'en-US', langs: ['en-US', 'en', 'fr'] },
      { lang: 'en-US', langs: ['en-US', 'en', 'es'] },
      { lang: 'en-US', langs: ['en-US', 'en', 'ja'] },
      { lang: 'en-GB', langs: ['en-GB', 'en'] },
      { lang: 'de-DE', langs: ['de-DE', 'de', 'en-US', 'en'] },
      { lang: 'fr-FR', langs: ['fr-FR', 'fr', 'en-US', 'en'] },
      { lang: 'es-ES', langs: ['es-ES', 'es', 'en', 'en-US'] },
      { lang: 'ja-JP', langs: ['ja', 'en-US', 'en'] },
      { lang: 'zh-CN', langs: ['zh-CN', 'zh', 'en-US', 'en'] },
      { lang: 'ru-RU', langs: ['ru-RU', 'ru', 'en-US', 'en'] },
      { lang: 'pt-BR', langs: ['pt-BR', 'pt', 'en-US', 'en'] },
      { lang: 'ko-KR', langs: ['ko-KR', 'ko', 'en-US', 'en'] },
      { lang: 'nl-NL', langs: ['nl-NL', 'nl', 'en-US', 'en'] },
      { lang: 'pl-PL', langs: ['pl-PL', 'pl', 'en'] },
    ];
    return r.pick(langOptions);
  }

  _genTimezone(r) {
    const timezones = [
      'America/New_York', 'America/Chicago', 'America/Denver',
      'America/Los_Angeles', 'America/Anchorage', 'America/Sao_Paulo',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin',
      'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam',
      'Europe/Moscow', 'Europe/Istanbul', 'Europe/Warsaw',
      'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai',
      'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
      'Australia/Sydney', 'Pacific/Auckland',
    ];
    return r.pick(timezones);
  }

  _genAudio(r) {
    // AudioContext fingerprint: sampleRate, channelCount, maxChannelCount
    // These are realistic values for modern browsers
    return {
      sampleRate: r.pick([44100, 44100, 44100, 48000]),
      baseLatency: 0.005 + r.next() * 0.02,
      outputLatency: 0.01 + r.next() * 0.03,
      maxChannelCount: r.pick([2, 2, 2, 6, 8]),
      state: 'running',
      // AudioContext noise offset (applied to float samples)
      noiseOffset: r.next() * 0.0001 - 0.00005, // tiny deterministic offset
    };
  }

  _genWebGPU(gpu, os, r) {
    const archMap = {
      'RTX 4070': { arch: 'ampere', vendor: 'nvidia' },
      'RTX 4060': { arch: 'ampere', vendor: 'nvidia' },
      'RTX 3060': { arch: 'ampere', vendor: 'nvidia' },
      'GTX 1660': { arch: 'turing', vendor: 'nvidia' },
      'RX 6700': { arch: 'rdna2', vendor: 'amd' },
      'RX 6800': { arch: 'rdna2', vendor: 'amd' },
      'UHD 630': { arch: 'gen9', vendor: 'intel' },
      'UHD 770': { arch: 'gen12', vendor: 'intel' },
      'Arc A770': { arch: 'xe', vendor: 'intel' },
      'M1': { arch: 'apple-gpu', vendor: 'apple' },
      'M2': { arch: 'apple-gpu', vendor: 'apple' },
      'M3': { arch: 'apple-gpu', vendor: 'apple' },
    };

    let arch = 'unknown', vendor = 'unknown';
    for (const [key, val] of Object.entries(archMap)) {
      if (gpu.unmaskedRenderer.includes(key)) {
        arch = val.arch;
        vendor = val.vendor;
        break;
      }
    }

    const vendorName = {
      nvidia: 'NVIDIA',
      amd: 'AMD',
      intel: 'Intel',
      apple: 'Apple',
      unknown: 'Google',
    }[vendor] || 'Google';

    return {
      vendor: vendorName,
      architecture: arch,
      device: gpu.unmaskedRenderer,
      description: gpu.unmaskedRenderer,
      features: [], // WebGPU features are dynamic, but we provide a stable set
    };
  }

  /** Get the generated profile */
  getProfile() {
    return this.profile;
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.ProfileEngine = ProfileEngine;
}
