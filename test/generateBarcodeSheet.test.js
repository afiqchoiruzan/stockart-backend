const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderBarcodeSvg, renderSheet, escapeHtml, formatRupiah } = require('../scripts/generateBarcodeSheet');

test('renderBarcodeSvg: EAN-13 untuk 13 digit valid, CODE128 untuk lainnya', () => {
  const ean = renderBarcodeSvg('2000000000015');
  assert.equal(ean.format, 'EAN-13');
  assert.match(ean.svg, /^<svg[^>]*viewBox=/);
  assert.match(ean.svg, /fill="#FFFFFF"/); // latar putih
  assert.equal(renderBarcodeSvg('2000000000016').format, 'CODE128'); // check digit salah
  assert.equal(renderBarcodeSvg('ATK-TEST-001').format, 'CODE128');
  assert.equal(renderBarcodeSvg('12345678').format, 'CODE128');
});

test('renderSheet: satu kartu per produk, teks di-escape, label nonaktif', () => {
  const html = renderSheet([
    { nama: 'Kopi <Mix> & "Gula"', kodeProduk: 'MN005', barcode: '2000000000015', hargaJual: 15000, aktif: true },
    { nama: 'Produk lama', kodeProduk: 'OLD-1', barcode: 'OLD-BARCODE', hargaJual: 0, aktif: false },
  ], new Date('2026-11-16T03:00:00Z'));
  assert.equal(html.match(/<article class="card">/g).length, 2);
  assert.ok(html.includes('Kopi &lt;Mix&gt; &amp; &quot;Gula&quot;'));
  assert.ok(!html.includes('<Mix>'));
  assert.equal(html.match(/class="badge">Nonaktif/g).length, 1);
  assert.ok(html.includes('MN005 · EAN-13') && html.includes('OLD-1 · CODE128'));
  assert.ok(html.includes('@media print') && html.includes('size: A4'));
  assert.equal(escapeHtml("'"), '&#39;');
  assert.equal(formatRupiah(15000).replace(/\s/g, ' '), 'Rp 15.000');
});
