const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ean13CheckDigit,
  isValidEan13,
  isDummyBarcode,
  buildDummyBarcode,
  planBarcodes,
  toCsv,
} = require('../scripts/seedBarcodes');

test('ean13CheckDigit: menghitung check digit EAN-13 yang benar', () => {
  assert.equal(ean13CheckDigit('400638133393'), 1); // 4006381333931
  assert.equal(ean13CheckDigit('590123412345'), 7); // 5901234123457 (contoh GS1)
  assert.equal(ean13CheckDigit('200000000001'), 5); // sum 15 → (10 - 5) % 10
  assert.equal(ean13CheckDigit('000000000000'), 0); // sum % 10 === 0 → 0, bukan 10
  for (const bad of ['12345678901', '1234567890123', '40063813339A', 400638133393, null]) {
    assert.throws(() => ean13CheckDigit(bad), `input ${JSON.stringify(bad)} harus ditolak`);
  }
});

test('isValidEan13 dan isDummyBarcode', () => {
  assert.equal(isValidEan13('4006381333931'), true);
  assert.equal(isValidEan13('4006381333932'), false);
  assert.equal(isValidEan13('400638133393'), false);
  assert.equal(isDummyBarcode('2000000000015'), true);
  assert.equal(isDummyBarcode('2000000000016'), false); // check digit salah
  assert.equal(isDummyBarcode('4006381333931'), false); // bukan prefix 200
  assert.equal(isDummyBarcode(undefined), false);
});

test('buildDummyBarcode: "200" + 9 digit urut + check digit', () => {
  assert.equal(buildDummyBarcode(1), '2000000000015');
  assert.equal(buildDummyBarcode(2), '2000000000022');
  assert.equal(buildDummyBarcode(999999999), `200999999999${ean13CheckDigit('200999999999')}`);
  for (let seq = 1; seq <= 50; seq += 1) assert.ok(isValidEan13(buildDummyBarcode(seq)));
  for (const bad of [0, -1, 1.5, 1e9]) assert.throws(() => buildDummyBarcode(bad));
});

test('planBarcodes: idempoten, lanjut dari nomor tertinggi, force hanya menimpa dummy', () => {
  const products = [
    { _id: 'a', kodeProduk: 'A', nama: 'A' },
    { _id: 'b', kodeProduk: 'B', nama: 'B', barcode: buildDummyBarcode(7) },
    { _id: 'c', kodeProduk: 'C', nama: 'C', barcode: '4006381333931' }, // barcode pabrik
    { _id: 'd', kodeProduk: 'D', nama: 'D' },
  ];

  const normal = planBarcodes(products);
  assert.deepEqual(normal.plan.map((i) => [i.product._id, i.barcode]),
    [['a', buildDummyBarcode(8)], ['d', buildDummyBarcode(9)]]);
  assert.equal(normal.skipped, 2);
  assert.equal(normal.startSequence, 8);

  // Setelah diisi, dijalankan ulang → 0 perubahan.
  const filled = products.map((p) => ({ ...p, barcode: p.barcode
    || normal.plan.find((i) => i.product._id === p._id).barcode }));
  assert.equal(planBarcodes(filled).plan.length, 0);

  // --force: semua dummy dinomori ulang dari 1, barcode pabrik tidak disentuh.
  const forced = planBarcodes(filled, { force: true });
  assert.deepEqual(forced.plan.map((i) => i.product._id), ['a', 'b', 'd']);
  assert.deepEqual(forced.plan.map((i) => i.barcode), [1, 2, 3].map(buildDummyBarcode));
  assert.equal(forced.plan.find((i) => i.product._id === 'b').oldBarcode, buildDummyBarcode(7));
  assert.ok(!forced.plan.some((i) => i.product._id === 'c'));
});

test('toCsv: header + satu baris per produk, field berkoma di-quote', () => {
  const csv = toCsv([
    { kodeProduk: 'SM001', nama: 'Beras 5kg', barcode: '2000000000015' },
    { kodeProduk: 'SM002', nama: 'Kopi "Mix", renteng', barcode: undefined },
  ]);
  assert.equal(csv,
    'kodeProduk,nama,barcode\n'
    + 'SM001,Beras 5kg,2000000000015\n'
    + 'SM002,"Kopi ""Mix"", renteng",\n');
});
