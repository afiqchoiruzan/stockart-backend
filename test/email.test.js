'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLowStockEmailSubject,
  buildLowStockEmailHeader,
  buildLowStockEmailBody,
} = require('../services/emailService');

test('Email Alert Low Stock: validasi subject, header banner, dan body table', async (t) => {
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

  await t.test('Subject email membedakan status kritis stok habis', () => {
    const subjectKritis = buildLowStockEmailSubject(sampleProducts, new Date('2026-11-12T10:00:00Z'));
    assert.match(subjectKritis, /🚨 \[StockArt Kritis\]/);
    assert.match(subjectKritis, /1 Produk Habis/);
    assert.match(subjectKritis, /1 Menipis/);

    const nonKritis = [sampleProducts[1]];
    const subjectWarning = buildLowStockEmailSubject(nonKritis, new Date('2026-11-12T10:00:00Z'));
    assert.match(subjectWarning, /⚠️ \[StockArt Alert\]/);
    assert.match(subjectWarning, /1 Produk Stok Menipis/);
  });

  await t.test('Header email memuat identitas Toko Berkah dan waktu deteksi WIB', () => {
    const headerHtml = buildLowStockEmailHeader(sampleProducts, {
      wibDateTime: 'Kamis, 12 November 2026, 20:55 WIB',
      isCritical: true,
      habisCount: 1,
      menipisCount: 1,
    });
    assert.match(headerHtml, /Toko Kelontong "Berkah"/);
    assert.match(headerHtml, /STATUS: STOK HABIS \(KRITIS\)/);
    assert.match(headerHtml, /Kamis, 12 November 2026, 20:55 WIB/);
  });

  await t.test('Body email memuat seluruh field Product model: kode, nama, kategori, stok, satuan, min, harga modal', () => {
    const bodyHtml = buildLowStockEmailBody(sampleProducts, {
      to: 'owner@test.com',
      wibDateTime: 'Kamis, 12 November 2026, 20:55 WIB',
    });

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
    assert.match(bodyHtml, /Rp 35\.000/); // format harga modal
    assert.match(bodyHtml, /owner@test\.com/);
  });
});
