/**
 * FingerprintSync v2.0.7 — Canvas hooks (MAIN world, document_start)
 * Exact Canvas Defender approach: Proxy + in-place pixel modification
 * + Sandboxed iframe bridge (Canvas Defender's second block)
 */

// ── Global PRNG — Phase 2 (page-context.js) can re-seed via window.__fpsync_prng ──
window.__fpsync_prng = (function() {
  var state = (crypto.getRandomValues(new Uint32Array(1))[0]) | 1;
  function next() {
    var t = (state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next: next,
    setSeed: function(s) { state = s | 0; },
    getState: function() { return state; }
  };
})();

// ═══════════════════════════════════════════════════════════════
// BLOCK 0 — getContext hook: suppress willReadFrequently warning
// ═══════════════════════════════════════════════════════════════
{
  var _origGC = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    if (type === '2d') {
      if (!args[0] || typeof args[0] !== 'object') args[0] = { willReadFrequently: true };
      else if (!args[0].willReadFrequently) args[0] = Object.assign({}, args[0], { willReadFrequently: true });
    }
    return _origGC.call(this, type, ...args);
  };
}

// ═══════════════════════════════════════════════════════════════
// BLOCK 1 — Canvas hooks (exact Canvas Defender approach)
// ═══════════════════════════════════════════════════════════════
{
  var _getImageData = CanvasRenderingContext2D.prototype.getImageData;
  var _prng = window.__fpsync_prng;

  var noisify = function(canvas, context) {
    if (context) {
      var shift = {
        'r': Math.floor(_prng.next() * 10) - 5,
        'g': Math.floor(_prng.next() * 10) - 5,
        'b': Math.floor(_prng.next() * 10) - 5,
        'a': Math.floor(_prng.next() * 10) - 5
      };
      var width = canvas.width;
      var height = canvas.height;
      if (width && height) {
        var imageData = _getImageData.apply(context, [0, 0, width, height]);
        for (var i = 0; i < height; i++) {
          for (var j = 0; j < width; j++) {
            var n = ((i * (width * 4)) + (j * 4));
            imageData.data[n + 0] = Math.min(255, Math.max(0, imageData.data[n + 0] + shift.r));
            imageData.data[n + 1] = Math.min(255, Math.max(0, imageData.data[n + 1] + shift.g));
            imageData.data[n + 2] = Math.min(255, Math.max(0, imageData.data[n + 2] + shift.b));
            imageData.data[n + 3] = Math.min(255, Math.max(0, imageData.data[n + 3] + shift.a));
          }
        }
        context.putImageData(imageData, 0, 0);
      }
    }
  };

  HTMLCanvasElement.prototype.toBlob = new Proxy(HTMLCanvasElement.prototype.toBlob, {
    apply: function(target, self, args) {
      noisify(self, self.getContext('2d'));
      return Reflect.apply(target, self, args);
    }
  });

  HTMLCanvasElement.prototype.toDataURL = new Proxy(HTMLCanvasElement.prototype.toDataURL, {
    apply: function(target, self, args) {
      noisify(self, self.getContext('2d'));
      return Reflect.apply(target, self, args);
    }
  });

  CanvasRenderingContext2D.prototype.getImageData = new Proxy(CanvasRenderingContext2D.prototype.getImageData, {
    apply: function(target, self, args) {
      noisify(self.canvas, self);
      return Reflect.apply(target, self, args);
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// BLOCK 2 — Sandboxed iframe bridge (exact Canvas Defender approach)
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
            e.source.CanvasRenderingContext2D.prototype.getImageData = CanvasRenderingContext2D.prototype.getImageData;
          }
        } catch (ex) {}
        try {
          if (e.source.HTMLCanvasElement) {
            e.source.HTMLCanvasElement.prototype.toBlob = HTMLCanvasElement.prototype.toBlob;
            e.source.HTMLCanvasElement.prototype.toDataURL = HTMLCanvasElement.prototype.toDataURL;
          }
        } catch (ex) {}
        // Also copy the PRNG so the iframe uses the same seed
        try {
          e.source.__fpsync_prng = window.__fpsync_prng;
        } catch (ex) {}
      }
    }
  }, false);
}
