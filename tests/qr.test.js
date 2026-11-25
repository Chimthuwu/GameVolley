// QR encoder tests: structure, the known format-info vector, and the Reed-Solomon
// root property (every codeword polynomial must vanish at each of the 16 ECC roots).
const assert = require('assert');
const qr = require('../src/shared/qr.js');

(async () => {
  const code = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 chars, the real pairing-code length
  const encoded = qr.encodeText(code);
  assert.strictEqual(encoded.size, 25, 'version 2 is 25x25');
  assert.strictEqual(encoded.version, 2, 'version 2');
  assert.strictEqual(encoded.ecc, 'M', 'ECC level M');
  assert.ok(encoded.mask >= 0 && encoded.mask <= 7, 'a valid mask was chosen');
  assert.strictEqual(encoded.modules.length, 25, '25 rows');
  assert.ok(encoded.modules.every((row) => row.length === 25), '25 columns');

  // Three finder patterns + separators, orientation marker in the top-left.
  assert.strictEqual(encoded.modules[0][0], true, 'top-left finder dark');
  assert.strictEqual(encoded.modules[1][1], false, 'finder inner ring light');
  assert.strictEqual(encoded.modules[2][2], true, 'finder core dark');
  assert.strictEqual(encoded.modules[0][7], false, 'separator is light');
  assert.strictEqual(encoded.modules[0][18], true, 'top-right finder dark');
  assert.strictEqual(encoded.modules[18][0], true, 'bottom-left finder dark');
  assert.strictEqual(encoded.modules[6][8], true, 'timing pattern starts dark');
  assert.strictEqual(encoded.modules[6][9], false, 'timing pattern alternates');
  assert.strictEqual(encoded.modules[17][8], true, 'the mandatory dark module is dark');

  // Known QR format-info constant: ECC M (bits 00) + mask 0 = 0x5412 after BCH + XOR.
  assert.strictEqual(qr.formatBits(0), 0x5412, 'format info matches the QR spec vector');
  assert.notStrictEqual(qr.formatBits(1), qr.formatBits(0), 'different masks have different format info');

  // Reed-Solomon correctness: generator roots are α^0..α^15, so the full codeword
  // polynomial must evaluate to zero at every one of them.
  const data = qr.dataCodewords(code);
  assert.strictEqual(data.length, 28, '28 data codewords');
  assert.strictEqual(data[0] >>> 4, 0b0100, 'byte mode indicator');
  const ecc = qr.rsRemainder(data);
  assert.strictEqual(ecc.length, 16, '16 ECC codewords');
  const all = [...data, ...ecc];
  for (let root = 0; root < 16; root++) {
    // (gfMul expects the field element α^root; multiplying by 2 walks the powers of α.)
    let y = 0, alpha = 1;
    for (let i = 0; i < root; i++) alpha = qr.gfMul(alpha, 2);
    for (const coefficient of all) y = qr.gfMul(y, alpha) ^ coefficient;
    assert.strictEqual(y, 0, `codeword polynomial vanishes at α^${root}`);
  }

  const svg = qr.renderSvg(code, { scale: 3, margin: 2 });
  assert.match(svg, /^<svg/, 'produces an SVG document');
  assert.match(svg, /width="87" height="87"/, '25+2*2 modules at scale 3 = 87px');
  assert.match(svg, /aria-label="Pairing code QR"/, 'accessible label');
  assert.ok(svg.includes('<rect'), 'contains module rectangles');

  assert.throws(() => qr.encodeText('x'.repeat(27)), /too long/, 'oversized input rejected');
  assert.notDeepStrictEqual(qr.encodeText(code).modules, qr.encodeText('other-code-abcdefgh').modules,
    'different codes produce different matrices');
  assert.deepStrictEqual(qr.encodeText(code).modules, encoded.modules, 'encoding is deterministic');

  console.log('qr.test.js: PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });
