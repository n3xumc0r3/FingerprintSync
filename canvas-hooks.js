/**
 * FingerprintSync v2.0.9 — Canvas hooks (MAIN world, document_start)
 *
 * NON-DESTRUCTIVE approach: noise is added to OUTPUT only (toDataURL/toBlob),
 * the original canvas is NEVER modified. This prevents breaking canvas-based
 * games (Poki, etc.) that rely on pixel-accurate getImageData for collision
 * detection and rendering.
 *
 * Changes from v2.0.7:
 * - Removed willReadFrequently forcing (was forcing CPU-backed canvases, killing GPU perf)
 * - toDataURL/toBlob: clone to temp canvas, noise the clone, call method on clone
 * - getImageData: NO noise (games use it for collision detection / pixel manipulation)
 * - Sandboxed iframe bridge preserved
 */

// ── Global PRNG — Phase 2 (fp-runtime.js) can re-seed via window.__fpsync_prng ──
window.__fpsync_prng = (function() {
  var state = (crypto.getRandomValues(new Uint32Array(1))[0]) | 1;
  function next() {
    var t = (state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 1);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next: next,
    setSeed: function(s) { state = s | 0; },
    getState: function() { return state; }
  };
})();

// ═══════════════════════════════════════════════════════════════
// BLOCK 1 — Non-destructive Canvas hooks
// ═══════════════════════════════════════════════════════════════
{
  var _getImageData = CanvasRenderingContext2D.prototype.getImageData;
  var _prng = window.__fpsync_prng;

  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  // Generate a deterministic per-call color shift (same seed → same shift)
  function getShift() {
    return {
      r: Math.floor(_prng.next() * 10) - 5,
      g: Math.floor(_prng.next() * 10) - 5,
      b: Math.floor(_prng.next() * 10) - 5,
      a: Math.floor(_prng.next() * 10) - 5
    };
  }

  // Add uniform noise to ImageData pixels in-place
  function addNoise(imageData) {
    var shift = getShift();
    var data = imageData.data;
    for (var i = 0, len = data.length; i < len; i += 4) {
      data[i]     = clamp(data[i]     + shift.r);
      data[i + 1] = clamp(data[i + 1] + shift.g);
      data[i + 2] = clamp(data[i + 2] + shift.b);
      data[i + 3] = clamp(data[i + 3] + shift.a);
    }
    return imageData;
  }

  // Clone a canvas, apply noise, call the export method on the noisy clone.
  // The original canvas is NEVER touched.
  function noisifiedExport(target, self, args) {
    var w = self.width, h = self.height;
    if (!w || !h) return Reflect.apply(target, self, args);
    try {
      var tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      var tmpCtx = tmp.getContext('2d');
      tmpCtx.drawImage(self, 0, 0);
      var imgData = _getImageData.apply(tmpCtx, [0, 0, w, h]);
      addNoise(imgData);
      tmpCtx.putImageData(imgData, 0, 0);
      return Reflect.apply(target, tmp, args);
    } catch (e) {
      return Reflect.apply(target, self, args);
    }
  }

  HTMLCanvasElement.prototype.toDataURL = new Proxy(HTMLCanvasElement.prototype.toDataURL, {
    apply: function(target, self, args) {
      return noisifiedExport(target, self, args);
    }
  });

  HTMLCanvasElement.prototype.toBlob = new Proxy(HTMLCanvasElement.prototype.toBlob, {
    apply: function(target, self, args) {
      return noisifiedExport(target, self, args);
    }
  });

  // getImageData: intentionally NOT noisified.
  // Games use getImageData for collision detection, pixel manipulation, and render reading.
  // Adding noise here breaks game logic. The main fingerprint vector (toDataURL) is covered.
}

// ═══════════════════════════════════════════════════════════════
// BLOCK 2 — Sandboxed iframe bridge
// When a sandboxed iframe (without allow-scripts) is encountered,
// our MAIN world script can't run there. The ISOLATED world script
// in the iframe sends a postMessage to the parent. This block
// receives it and copies the hooked prototypes into the iframe.
// ═══════════════════════════════════════════════════════════════
{
  var mkey = '__fpsync_sandboxed';
  document.documentElement.setAttribute(mkey, '');
  window.addEventListener('message', function(e) {
    if (e.data && e.data === mkey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.source) {
        try {
          if (e.source.CanvasRenderingContext2D) {
            e.source.CanvasRenderingContext2D.prototype.toDataURL = CanvasRenderingContext2D.prototype.toDataURL;
          }
        } catch (ex) {}
        try {
          if (e.source.HTMLCanvasElement) {
            e.source.HTMLCanvasElement.prototype.toDataURL = HTMLCanvasElement.prototype.toDataURL;
            e.source.HTMLCanvasElement.prototype.toBlob = HTMLCanvasElement.prototype.toBlob;
          }
        } catch (ex) {}
        try {
          e.source.__fpsync_prng = window.__fpsync_prng;
        } catch (ex) {}
      }
    }
  }, false);
}
