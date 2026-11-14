'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLowStockEmailSubject,
  buildLowStockEmailHeader,
  buildLowStockEmailBody,
} = require('../services/emailService');

const EMOJI_REGEX = /[\p{Extended_Pictographic}\u2600-\u27BF]/u;

const ALLOWED_MONOCHROME_HEX = new Set([
  '#000000',
  '#111111',
  '#171717',
  '#262626',
  '#404040',
  '#525252',
  '#737373',
  '#A3A3A3',
  '#D4D4D4',
  '#E5E5E5',
  '#F5F5F5',
  '#FAFAFA',
  '#FFFFFF',
]);

const ALLOWED_RED_HEX = new Set([
  '#DC2626',
  '#991B1B',
  '#B91C1C',
  '#FEF2F2',
  '#FECACA',
  '#FCA5A5',
]);

test('Email Alert Low Stock: desain monokrom tanpa emoji dengan aksen merah khusus low stock', async (t) => {
  const sampleProducts = [
    {
      _id: '66e511111111111111111111',
      nama: 'Minyak Goreng Bimoli 2L',
      kodeProduk: 'SM002',
      kategori: 'Sembako',
      hargaBeli: 35000,
      hargaJual: 38000,
      stok: 0, // Habis
      satuan: 'pouch',
      stokMinimum: 5,
      deskripsi: 'Minyak kelapa sawit',
      aktif: true,
    },
    {
      _id: '66e522222222222222222222',
      nama: 'Kopi Kapal Api Mix',
      kodeProduk: 'MN005',
      kategori: 'Minuman',
      hargaBeli: 12000,
      hargaJual: 15000,
      stok: 2, // Menipis
      satuan: 'renteng',
      stokMinimum: 5,
      deskripsi: 'Kopi sachet 10s',
      aktif: true,
    },
  ];

  await t.test('Subject email tegas tanpa emoji dan membedakan status kritis stok habis', () => {
    const subjectKritis = buildLowStockEmailSubject(sampleProducts, new Date('2026-11-12T10:00:00Z'));
    assert.equal(EMOJI_REGEX.test(subjectKritis), false, `Subject masih mengandung emoji: ${subjectKritis}`);
    assert.match(subjectKritis, /^\[StockArt Kritis\]/);
    assert.match(subjectKritis, /1 Produk Habis/);
    assert.match(subjectKritis, /1 Menipis/);

    const nonKritis = [sampleProducts[1]];
    const subjectWarning = buildLowStockEmailSubject(nonKritis, new Date('2026-11-12T10:00:00Z'));
    assert.equal(EMOJI_REGEX.test(subjectWarning), false, `Subject masih mengandung emoji: ${subjectWarning}`);
    assert.match(subjectWarning, /^\[StockArt Alert\]/);
    assert.match(subjectWarning, /1 Produk Stok Menipis/);
  });

  await t.test('Header email monokrom tanpa emoji atau gradien dengan penanda merah status low stock', () => {
    const headerHtml = buildLowStockEmailHeader(sampleProducts, {
      wibDateTime: 'Kamis, 12 November 2026, 20:55 WIB',
      isCritical: true,
      habisCount: 1,
      menipisCount: 1,
    });
    assert.equal(EMOJI_REGEX.test(headerHtml), false, 'Header masih mengandung emoji');
    assert.equal(/linear-gradient/i.test(headerHtml), false, 'Header tidak boleh memakai linear-gradient');
    assert.match(headerHtml, /Toko Kelontong "Berkah"/);
    assert.match(headerHtml, /STATUS: STOK HABIS \(KRITIS\)/);
    assert.match(headerHtml, /Kamis, 12 November 2026, 20:55 WIB/);

    const hexMatches = headerHtml.match(/#[0-9A-Fa-f]{6}\b/g) || [];
    for (const hex of hexMatches) {
      const upper = hex.toUpperCase();
      assert.ok(
        ALLOWED_MONOCHROME_HEX.has(upper) || ALLOWED_RED_HEX.has(upper),
        `Warna tidak diizinkan di header: ${upper}`
      );
    }
  });

  await t.test('Body email monokrom tanpa emoji, memuat seluruh field Product, dan hanya memakai merah pada penanda low stock', () => {
    const bodyHtml = buildLowStockEmailBody(sampleProducts, {
      to: 'owner@test.com',
      wibDateTime: 'Kamis, 12 November 2026, 20:55 WIB',
    });

    assert.equal(EMOJI_REGEX.test(bodyHtml), false, 'Body masih mengandung emoji');
    assert.equal(/linear-gradient/i.test(bodyHtml), false, 'Body tidak boleh memakai linear-gradient');

    // Ringkasan KPI
    assert.match(bodyHtml, /TOTAL TERDAMPAK/);
    assert.match(bodyHtml, /STOK HABIS \(0\)/);
    assert.match(bodyHtml, /STOK MENIPIS/);

    // Dokumen produk
    assert.match(bodyHtml, /SM002/);
    assert.match(bodyHtml, /Minyak Goreng Bimoli 2L/);
    assert.match(bodyHtml, /pouch/);
    assert.match(bodyHtml, /HABIS \(0\)/);
    assert.match(bodyHtml, /MN005/);
    assert.match(bodyHtml, /Kopi Kapal Api Mix/);
    assert.match(bodyHtml, /renteng/);
    assert.match(bodyHtml, /MENIPIS/);
    assert.match(bodyHtml, /Rp 35\.000/);
    assert.match(bodyHtml, /Rp 211\.000/); // (5-0)*35000 + (5-2)*12000 = 175000 + 36000
    assert.match(bodyHtml, /owner@test\.com/);

    // Pastikan seluruh warna hex hanya monokrom atau merah penanda low stock
    const hexMatches = bodyHtml.match(/#[0-9A-Fa-f]{6}\b/g) || [];
    assert.ok(hexMatches.some((h) => ALLOWED_RED_HEX.has(h.toUpperCase())), 'Harus ada aksen merah untuk penanda low stock');
    for (const hex of hexMatches) {
      const upper = hex.toUpperCase();
      assert.ok(
        ALLOWED_MONOCHROME_HEX.has(upper) || ALLOWED_RED_HEX.has(upper),
        `Warna di luar monokrom/merah ditemukan di body: ${upper}`
      );
    }
  });

  await t.test('Produk dengan stok aman tidak diberi penanda warna merah', () => {
    const safeItem = {
      _id: '66e533333333333333333333',
      nama: 'Beras Aman 5kg',
      kodeProduk: 'SM001',
      kategori: 'Sembako',
      hargaBeli: 60000,
      hargaJual: 65000,
      stok: 20,
      satuan: 'sak',
      stokMinimum: 5,
      aktif: true,
    };
    const bodyHtml = buildLowStockEmailBody([safeItem], {
      to: 'owner@test.com',
      wibDateTime: 'Kamis, 12 November 2026, 20:55 WIB',
    });
    const hexMatches = bodyHtml.match(/#[0-9A-Fa-f]{6}\b/g) || [];
    for (const hex of hexMatches) {
      const upper = hex.toUpperCase();
      assert.ok(
        ALLOWED_MONOCHROME_HEX.has(upper),
        `Produk aman hanya boleh memakai warna monokrom netral, ditemukan: ${upper}`
      );
      assert.equal(
        ALLOWED_RED_HEX.has(upper),
        false,
        `Produk aman tidak boleh memakai warna merah (${upper})`
      );
    }
  });
});
