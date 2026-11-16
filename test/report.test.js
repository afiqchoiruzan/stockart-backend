'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDateFilter,
  parseRevenueInterval,
  TOP_PRODUCTS_SORT,
} = require('../services/reportService');

test('buildDateFilter: rentang tanggal dihitung dari 00:00 WIB', () => {
  const filter = buildDateFilter('2026-11-10', '2026-11-16');
  // 10 Nov 2026 00:00 WIB = 9 Nov 2026 17:00 UTC
  assert.equal(filter.$gte.toISOString(), '2026-11-09T17:00:00.000Z');
  // Batas akhir eksklusif: 17 Nov 2026 00:00 WIB = 16 Nov 2026 17:00 UTC
  assert.equal(filter.$lt.toISOString(), '2026-11-16T17:00:00.000Z');
  assert.equal(filter.$lte, undefined);
});

test('buildDateFilter: transaksi dini hari WIB masuk ke tanggal WIB yang benar', () => {
  const filter = buildDateFilter('2026-11-16', '2026-11-16');
  // 16 Nov 2026 01:00 WIB = 15 Nov 2026 18:00 UTC -> termasuk 16 Nov
  const diniHari = new Date('2026-11-15T18:00:00Z');
  assert.ok(diniHari >= filter.$gte && diniHari < filter.$lt);
  // 16 Nov 2026 23:30 WIB = 16 Nov 2026 16:30 UTC -> termasuk 16 Nov
  const malam = new Date('2026-11-16T16:30:00Z');
  assert.ok(malam >= filter.$gte && malam < filter.$lt);
  // 17 Nov 2026 00:30 WIB = 16 Nov 2026 17:30 UTC -> sudah hari berikutnya
  const besok = new Date('2026-11-16T17:30:00Z');
  assert.ok(!(besok < filter.$lt));
});

test('buildDateFilter: hanya salah satu tanggal atau tanpa tanggal', () => {
  assert.deepEqual(buildDateFilter(), {});
  assert.deepEqual(Object.keys(buildDateFilter('2026-11-10')), ['$gte']);
  assert.deepEqual(Object.keys(buildDateFilter(undefined, '2026-11-16')), ['$lt']);
});

test('buildDateFilter: menolak format tanggal dan rentang tidak valid', () => {
  for (const [mulai, akhir] of [
    ['2026-02-30', undefined],
    ['16-11-2026', undefined],
    [undefined, '2026/11/16'],
    [['2026-11-16'], undefined],
    ['2026-11-17', '2026-11-16'],
  ]) {
    assert.throws(() => buildDateFilter(mulai, akhir), { statusCode: 400 });
  }
});

test('parseRevenueInterval: default hari, menerima jam, menolak nilai lain', () => {
  assert.equal(parseRevenueInterval(undefined), 'hari');
  assert.equal(parseRevenueInterval(''), 'hari');
  assert.equal(parseRevenueInterval('hari'), 'hari');
  assert.equal(parseRevenueInterval('jam'), 'jam');
  for (const bad of ['minggu', 'JAM', ['jam']]) {
    assert.throws(() => parseRevenueInterval(bad), { statusCode: 400 });
  }
});

test('TOP_PRODUCTS_SORT: urutan stabil saat jumlah terjual seri', () => {
  assert.deepEqual(Object.keys(TOP_PRODUCTS_SORT), ['totalTerjual', 'totalPendapatan', '_id']);
  assert.deepEqual(Object.values(TOP_PRODUCTS_SORT), [-1, -1, 1]);
});

test('generateReportPdfBuffer: PDF monokrom valid dengan grafik omzet & teks aman Latin-1', () => {
  const { generateReportPdfBuffer, sanitizeText } = require('../services/pdfService');

  assert.equal(sanitizeText('Laporan — 10 Nov'), 'Laporan - 10 Nov');
  assert.equal(sanitizeText('Rp 284.500 '), 'Rp 284.500 ');

  const buffer = generateReportPdfBuffer({
    periodeLabel: '2026-11-10 s/d 2026-11-16',
    summary: { totalProduk: 55, totalTransaksi: 6, totalOmzet: 284500, totalTerjual: 16, totalMasuk: 20 },
    topProducts: [{ namaProduk: 'Minyak (Bimoli) 2L', totalTerjual: 5, totalPendapatan: 150000 }],
    chart: {
      title: 'Omzet per Hari',
      points: [
        { label: 'Jum', sublabel: '13/11', omzet: 96000 },
        { label: 'Sab', sublabel: '14/11', omzet: 0 },
      ],
    },
    context: 'scheduled',
    frequency: 'weekly',
  });
  const content = buffer.toString('latin1');

  assert.ok(content.startsWith('%PDF-1.4'));
  assert.ok(content.trimEnd().endsWith('%%EOF'));
  assert.ok(content.includes('(Laporan Mingguan Penjualan & Stok)'));
  assert.ok(content.includes('(OMZET PER HARI)'));
  assert.ok(content.includes('(96 rb)'));
  // Tanda kurung di nama produk harus di-escape agar teks PDF tidak rusak
  assert.ok(content.includes(String.raw`(Minyak \(Bimoli\) 2L)`));
  // Monokrom: tidak ada lagi warna terracotta laporan lama
  assert.ok(!content.includes('0.831 0.404 0.263'));

  const empty = generateReportPdfBuffer({ periodeLabel: 'Semua Periode', summary: {}, topProducts: [] });
  assert.ok(empty.toString('latin1').includes('(Belum ada omzet pada periode ini.)'));
});

test('getFrontendBaseUrl: tautan email memakai URL frontend production, bukan localhost', () => {
  const { getFrontendBaseUrl } = require('../services/emailService');

  assert.equal(
    getFrontendBaseUrl({ CORS_ORIGIN: 'http://localhost:3000, https://stockart.vercel.app/' }),
    'https://stockart.vercel.app'
  );
  assert.equal(
    getFrontendBaseUrl({ FRONTEND_URL: 'https://app.example.com/', CORS_ORIGIN: 'https://stockart.vercel.app' }),
    'https://app.example.com'
  );
  assert.equal(getFrontendBaseUrl({ CORS_ORIGIN: 'http://127.0.0.1:3000' }), 'http://127.0.0.1:3000');
  assert.equal(getFrontendBaseUrl({}), 'http://localhost:3000');
});

test('buildReportHtml: email & salinan Drive menyertakan grafik omzet', () => {
  const { buildReportHtml } = require('../services/emailService');
  const base = {
    periodeLabel: '2026-11-10 s/d 2026-11-16',
    summary: { totalOmzet: 284500 },
    topProducts: [],
  };

  const withChart = buildReportHtml({
    ...base,
    chart: {
      title: 'Omzet per Hari',
      points: [
        { label: 'Jum', sublabel: '13/11', omzet: 96000 },
        { label: 'Sab', sublabel: '14/11', omzet: 0 },
        { label: 'Min', sublabel: '15/11', omzet: 188500 },
      ],
    },
  });
  assert.ok(withChart.includes('<!-- Grafik Omzet -->'));
  assert.ok(withChart.includes('Omzet per Hari'));
  assert.ok(withChart.includes('Total Rp 284.500'));
  assert.ok(withChart.includes('96 rb'));
  assert.ok(withChart.includes('189 rb'));
  assert.ok(withChart.includes('13/11'));
  // Batang tertinggi = tinggi plot penuh (120px), batang nol = garis tipis abu-abu
  assert.ok(withChart.includes('height:120px'));
  assert.ok(withChart.includes('background:#D4D4D4'));

  const emptyChart = buildReportHtml({ ...base, chart: { title: 'Omzet per Jam', points: [] } });
  assert.ok(emptyChart.includes('Belum ada omzet pada periode ini.'));

  const noChart = buildReportHtml(base);
  assert.ok(!noChart.includes('Total Rp 284.500'));
});

test('Laba kotor tampil di email & PDF laporan, dengan tanda estimasi bila perlu', () => {
  const { buildReportHtml } = require('../services/emailService');
  const { generateReportPdfBuffer } = require('../services/pdfService');
  const summary = { totalOmzet: 284500, totalLaba: 61500, labaEstimasi: false };

  const html = buildReportHtml({ periodeLabel: '2026-11-10 s/d 2026-11-16', summary, topProducts: [] });
  assert.ok(html.includes('Laba Kotor'));
  assert.ok(html.includes('Rp 61.500'));
  assert.ok(!html.includes('(estimasi)'));

  const htmlEstimasi = buildReportHtml({
    periodeLabel: '2026-11-10 s/d 2026-11-16',
    summary: { ...summary, labaEstimasi: true },
    topProducts: [],
  });
  assert.ok(htmlEstimasi.includes('(estimasi)'));

  const pdf = generateReportPdfBuffer({ periodeLabel: 'x', summary: { ...summary, labaEstimasi: true }, topProducts: [] })
    .toString('latin1');
  assert.ok(pdf.includes(String.raw`(Laba Kotor \(estimasi\))`));
  assert.ok(pdf.includes('(Rp 61.500)'));
});
