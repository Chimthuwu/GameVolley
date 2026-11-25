/* Minimal, dependency-free QR encoder for the 22-character pairing code.
 *
 * Fixed to QR version 2, byte mode, ECC level M (25x25 modules, 28 data codewords,
 * 16 Reed-Solomon codewords, one block). A 22-byte pairing code fits comfortably;
 * anything over 26 bytes is rejected rather than silently truncated.
 *
 * Keeping this on-device avoids sending the pairing secret to a third-party QR service.
 * UMD so it works in Node tests and in both built front-ends.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameVolleyQr = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIZE = 25;
  const DATA_CODEWORDS = 28;
  const ECC_CODEWORDS = 16;
  const VERSION = 2;
  const ECC_FORMAT_BITS = 0b00; // level M

  // GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D).
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsDivisor(degree) {
    // Ascending coefficients of ∏(x - α^i), excluding the leading 1.
    let g = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Uint8Array(g.length + 1);
      for (let j = 0; j < g.length; j++) {
        next[j + 1] ^= g[j];
        next[j] ^= gfMul(g[j], EXP[i]);
      }
      g = next;
    }
    // qrcodegen-style remainder loop consumes coefficients from x^(degree-1) down to
    // the constant term, so hand back descending coefficients without the leading 1.
    return g.slice(0, degree).reverse();
  }

  const DIVISOR = rsDivisor(ECC_CODEWORDS);

  function rsRemainder(data) {
    const result = new Uint8Array(ECC_CODEWORDS);
    for (const byte of data) {
      const factor = byte ^ result[0];
      result.copyWithin(0, 1);
      result[ECC_CODEWORDS - 1] = 0;
      for (let i = 0; i < ECC_CODEWORDS; i++) result[i] ^= gfMul(DIVISOR[i], factor);
    }
    return result;
  }

  function dataCodewords(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    if (bytes.length > 26) throw new Error('Pairing code is too long for a QR (max 26 bytes)');
    const bits = [];
    const push = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4);       // byte mode
    push(bytes.length, 8); // character count, versions 1-9
    for (const b of bytes) push(b, 8);
    while (bits.length % 8 !== 0 && bits.length < DATA_CODEWORDS * 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      out.push(byte);
    }
    for (let pad = 0xec; out.length < DATA_CODEWORDS; pad = pad === 0xec ? 0x11 : 0xec) out.push(pad);
    return out;
  }

  function makeMatrix() {
    const modules = Array.from({ length: SIZE }, () => new Uint8Array(SIZE));
    const fixed = Array.from({ length: SIZE }, () => new Uint8Array(SIZE));
    const set = (x, y, dark) => {
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
      modules[y][x] = dark ? 1 : 0;
      fixed[y][x] = 1;
    };

    // Timing patterns first; finder patterns below overwrite their intersections.
    for (let i = 0; i < SIZE; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

    for (const [fx, fy] of [[0, 0], [SIZE - 7, 0], [0, SIZE - 7]]) {
      for (let dy = -1; dy <= 7; dy++) {
        for (let dx = -1; dx <= 7; dx++) {
          const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
          const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          set(fx + dx, fy + dy, inside && (ring || core));
        }
      }
    }

    // Version 2 alignment pattern centred at (18, 18).
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        set(18 + dx, 18 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    set(8, SIZE - 8, true); // dark module
    return { modules, fixed, set };
  }

  function placeCodewords(matrix, codewords) {
    const { modules, fixed } = matrix;
    let bit = 0;
    for (let right = SIZE - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column
      for (let vert = 0; vert < SIZE; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? SIZE - 1 - vert : vert;
          if (!fixed[y][x] && bit < codewords.length * 8) {
            modules[y][x] = (codewords[bit >> 3] >>> (7 - (bit & 7))) & 1;
            bit++;
          }
        }
      }
    }
  }

  function formatBits(mask) {
    let data = (ECC_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    return bits;
  }

  function drawFormat(matrix, mask) {
    const bits = formatBits(mask);
    const bit = (i) => (bits >>> i) & 1;
    const set = matrix.set;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(SIZE - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, SIZE - 15 + i, bit(i));
    set(8, SIZE - 8, true);
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function applyMask(matrix, mask) {
    const fn = MASKS[mask];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (!matrix.fixed[y][x] && fn(x, y)) matrix.modules[y][x] ^= 1;
      }
    }
  }

  function penalty(matrix) {
    const m = matrix.modules;
    let score = 0;
    const runPenalty = (get, length) => {
      let run = 1, previous = get(0);
      for (let i = 1; i < length; i++) {
        const current = get(i);
        if (current === previous) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else { run = 1; previous = current; }
      }
    };
    for (let y = 0; y < SIZE; y++) runPenalty((x) => m[y][x], SIZE);
    for (let x = 0; x < SIZE; x++) runPenalty((y) => m[y][x], SIZE);
    for (let y = 0; y < SIZE - 1; y++) {
      for (let x = 0; x < SIZE - 1; x++) {
        const v = m[y][x];
        if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
      }
    }
    const finderLike = [true, false, true, true, true, false, true, false, false, false, false];
    const matches = (get, offset) => finderLike.every((want, i) => {
      const index = offset + i;
      return index >= 0 && index < SIZE && !!get(index) === want;
    });
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x <= SIZE - 11; x++) {
        if (matches((i) => m[y][i], x) || matches((i) => m[i][x], y)) score += 40;
      }
    }
    let dark = 0;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) dark += m[y][x];
    score += Math.floor(Math.abs(dark * 2 - SIZE * SIZE) / (SIZE * SIZE / 20)) * 10;
    return score;
  }

  function encodeText(text) {
    const data = dataCodewords(text);
    const ecc = rsRemainder(data);
    const codewords = [...data, ...ecc];
    const matrix = makeMatrix();
    placeCodewords(matrix, codewords);

    let bestMask = 0, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(matrix, mask);
      const score = penalty(matrix);
      applyMask(matrix, mask); // undo (XOR is its own inverse)
      if (score < bestScore) { bestScore = score; bestMask = mask; }
    }
    applyMask(matrix, bestMask);
    drawFormat(matrix, bestMask);

    return {
      size: SIZE,
      version: VERSION,
      ecc: 'M',
      mask: bestMask,
      modules: matrix.modules.map((row) => Array.from(row, (v) => !!v)),
    };
  }

  // SVG string so the pairing panel needs no canvas and no external image service.
  function renderSvg(text, options) {
    const opts = options || {};
    const qr = encodeText(text);
    const scale = Number.isFinite(opts.scale) ? Math.max(1, opts.scale) : 4;
    const margin = Number.isFinite(opts.margin) ? Math.max(0, opts.margin) : 2;
    const extent = (qr.size + margin * 2) * scale;
    let rects = '';
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) {
          rects += `<rect x="${(x + margin) * scale}" y="${(y + margin) * scale}" width="${scale}" height="${scale}"/>`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}" viewBox="0 0 ${extent} ${extent}" role="img" aria-label="Pairing code QR" shape-rendering="crispEdges"><rect width="${extent}" height="${extent}" fill="${opts.light || '#ffffff'}"/><g fill="${opts.dark || '#000000'}">${rects}</g></svg>`;
  }

  return {
    SIZE, DATA_CODEWORDS, ECC_CODEWORDS,
    encodeText, renderSvg, formatBits,
    dataCodewords, rsRemainder, gfMul, rsDivisor,
  };
});
