'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = require('../app');
const User = require('../models/User');
const Product = require('../models/Product');
const Transaction = require('../models/Transaction');
const StockEntry = require('../models/StockEntry');
const NotificationSetting = require('../models/NotificationSetting');
const { getReportSummary, buildRevenueChart, buildReportPdf } = require('../services/reportService');
const { recordStockEntry } = require('../services/stockEntryService');
const {
  REPORT_SETTINGS_KEY,
  validateReportSettingsPayload,
  getReportScheduleSettings,
  updateReportScheduleSettings,
  formatReportSettingsResponse,
} = require('../services/reportScheduleSettingsService');
const {
  getReportPeriodForOccurrence,
  runReportIfDue,
} = require('../services/reportScheduleService');

test('validateReportSettingsPayload: field jadwal & saveToDrive, menolak field lain', () => {
  assert.deepEqual(
    validateReportSettingsPayload({ digestFrequency: 'daily', digestTime: '06:30', saveToDrive: false }),
    {
      valid: true,
      errors: [],
      updates: { digestFrequency: 'daily', digestTime: '06:30', saveToDrive: false },
    }
  );
  assert.deepEqual(validateReportSettingsPayload({ saveToDrive: true }).updates, { saveToDrive: true });

  for (const payload of [
    null,
    [],
    {},
    { criticalAlertEnabled: true },
    { saveToDrive: 'ya' },
    { digestFrequency: 'yearly' },
    { digestTime: '7:00' },
    { digestWeekday: 7 },
    { digestDayOfMonth: 29 },
  ]) {
    assert.equal(validateReportSettingsPayload(payload).valid, false, JSON.stringify(payload));
  }
});

test('getReportPeriodForOccurrence: rentang hari penuh WIB sebelum slot jadwal', () => {
  // Slot 16 Nov 2026 07:00 WIB = 16 Nov 2026 00:00 UTC
  const slot = new Date('2026-11-16T00:00:00Z');
  assert.deepEqual(getReportPeriodForOccurrence('daily', slot), {
    tanggalMulai: '2026-11-15',
    tanggalAkhir: '2026-11-15',
  });
  assert.deepEqual(getReportPeriodForOccurrence('weekly', slot), {
    tanggalMulai: '2026-11-09',
    tanggalAkhir: '2026-11-15',
  });
  assert.deepEqual(getReportPeriodForOccurrence('monthly', slot), {
    tanggalMulai: '2026-10-16',
    tanggalAkhir: '2026-11-15',
  });

  // Slot 1 Des 2026 00:15 WIB = 30 Nov 2026 17:15 UTC -> tanggal slot tetap 1 Des (WIB)
  const lewatTengahMalam = new Date('2026-11-30T17:15:00Z');
  assert.deepEqual(getReportPeriodForOccurrence('monthly', lewatTengahMalam), {
    tanggalMulai: '2026-11-01',
    tanggalAkhir: '2026-11-30',
  });
});

test('Laporan otomatis & ringkasan: barang masuk, produk terjual, scheduler, dan HTTP settings', async (t) => {
  // Nama database ringkas (< 38 byte batas MongoDB Atlas M0) agar tetap terisolasi.
  const dbName = `t_rpt_${process.pid}_${Date.now().toString(36)}`;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'stockart_report_schedule_secret';
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });

  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.dropDatabase();
      }
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    }
  });

  await Promise.all([
    User.syncIndexes(),
    Product.syncIndexes(),
    Transaction.syncIndexes(),
    StockEntry.syncIndexes(),
    NotificationSetting.syncIndexes(),
  ]);

  await t.test('ringkasan menghitung produk terjual & barang masuk dalam rentang WIB', async () => {
    const [owner] = await User.create([
      { nama: 'Owner Rpt', username: `own_rpt_${Date.now()}`, password: 'x', role: 'pemilik' },
    ]);
    const product = await Product.create({ nama: 'Gula 1kg', hargaBeli: 12000, hargaJual: 15000, stok: 10 });

    // 16 Nov 2026 01:00 WIB (= 15 Nov 18:00 UTC) harus terhitung ke tanggal 16 Nov
    const masuk = await recordStockEntry({ product, jumlah: 10, sumber: 'produk_baru', userId: owner._id });
    await StockEntry.collection.updateOne({ _id: masuk._id }, { $set: { createdAt: new Date('2026-11-15T18:00:00Z') } });
    const restock = await recordStockEntry({ product, jumlah: 5, sumber: 'restock', userId: owner._id });
    await StockEntry.collection.updateOne({ _id: restock._id }, { $set: { createdAt: new Date('2026-11-16T10:00:00Z') } });
    // Di luar rentang: 17 Nov 2026 00:30 WIB
    const besok = await recordStockEntry({ product, jumlah: 99, sumber: 'restock', userId: owner._id });
    await StockEntry.collection.updateOne({ _id: besok._id }, { $set: { createdAt: new Date('2026-11-16T17:30:00Z') } });

    assert.equal(await recordStockEntry({ product, jumlah: 0, sumber: 'restock' }), null);

    const item = (jumlah) => ({ produk: product._id, jumlah, hargaSatuan: 15000, subtotal: jumlah * 15000 });
    await Transaction.collection.insertMany([
      { kasir: owner._id, detailBarang: [item(2), item(1)], totalHarga: 45000, status: 'selesai', createdAt: new Date('2026-11-16T02:00:00Z') },
      { kasir: owner._id, detailBarang: [item(4)], totalHarga: 60000, status: 'batal', createdAt: new Date('2026-11-16T03:00:00Z') },
    ]);

    const summary = await getReportSummary({ tanggalMulai: '2026-11-16', tanggalAkhir: '2026-11-16' });
    assert.equal(summary.totalTransaksi, 1);
    assert.equal(summary.totalOmzet, 45000);
    assert.equal(summary.totalTerjual, 3);
    assert.equal(summary.totalMasuk, 15);
  });

  await t.test('grafik & PDF laporan: per jam untuk 1 hari, per hari untuk rentang', async () => {
    // Transaksi selesai di atas: 16 Nov 2026 09:00 WIB, Rp45.000
    const hourly = await buildRevenueChart({ tanggalMulai: '2026-11-16', tanggalAkhir: '2026-11-16' });
    assert.equal(hourly.title, 'Omzet per Jam');
    assert.deepEqual(hourly.points, [{ label: '09', omzet: 45000 }]);

    const weekly = await buildRevenueChart({ tanggalMulai: '2026-11-10', tanggalAkhir: '2026-11-16' });
    assert.equal(weekly.title, 'Omzet per Hari');
    assert.equal(weekly.points.length, 7);
    assert.deepEqual(weekly.points[0], { label: 'Sel', sublabel: '10/11', omzet: 0 });
    assert.deepEqual(weekly.points[6], { label: 'Sen', sublabel: '16/11', omzet: 45000 });

    const longRange = await buildRevenueChart({ tanggalMulai: '2026-09-01', tanggalAkhir: '2026-11-16' });
    assert.equal(longRange.points.length, 31);
    assert.ok(longRange.note);

    const { buffer, fileName } = await buildReportPdf({ tanggalMulai: '2026-11-10', tanggalAkhir: '2026-11-16' });
    assert.equal(fileName, 'Laporan_Stockart_2026-11-10_2026-11-16.pdf');
    assert.equal(buffer.subarray(0, 8).toString('latin1'), '%PDF-1.4');
    assert.ok(buffer.toString('latin1').includes('(Omzet per Hari)') || buffer.toString('latin1').includes('(OMZET PER HARI)'));

    await assert.rejects(
      () => buildReportPdf({ tanggalMulai: '2026-11-17', tanggalAkhir: '2026-11-16' }),
      { statusCode: 400 }
    );
  });

  await t.test('scheduler: off tidak mengirim, slot jatuh tempo terkirim sekali dengan rentang benar', async () => {
    const calls = [];
    const send = async (payload) => {
      calls.push(payload);
      return { recipient: 'owner@example.com' };
    };
    const emailConfigured = () => true;

    const defaults = await getReportScheduleSettings(new Date('2026-11-14T00:00:00Z'));
    assert.equal(defaults.key, REPORT_SETTINGS_KEY);
    assert.equal(defaults.digestFrequency, 'off');

    const off = await runReportIfDue({ now: new Date('2026-11-16T01:00:00Z'), send, emailConfigured });
    assert.deepEqual([off.executed, off.reason], [false, 'off']);

    // Aktifkan harian 07:00 WIB pada 15 Nov 2026 12:00 WIB
    await updateReportScheduleSettings(
      { digestFrequency: 'daily', digestTime: '07:00', saveToDrive: false },
      new Date('2026-11-15T05:00:00Z'),
      { emailConfigured }
    );

    // 16 Nov 2026 06:59 WIB: belum jatuh tempo (slot 15 Nov 07:00 sudah lewat sebelum aktivasi)
    const early = await runReportIfDue({ now: new Date('2026-11-15T23:59:00Z'), send, emailConfigured });
    assert.equal(early.executed, false);

    // 16 Nov 2026 07:05 WIB: kirim laporan 15 Nov
    const sent = await runReportIfDue({ now: new Date('2026-11-16T00:05:00Z'), send, emailConfigured });
    assert.equal(sent.status, 'sent');
    assert.deepEqual(calls, [{
      tanggalMulai: '2026-11-15',
      tanggalAkhir: '2026-11-15',
      saveToDrive: false,
      context: 'scheduled',
      frequency: 'daily',
    }]);

    const again = await runReportIfDue({ now: new Date('2026-11-16T00:10:00Z'), send, emailConfigured });
    assert.equal(again.executed, false);
    assert.equal(calls.length, 1);

    const formatted = formatReportSettingsResponse(
      await getReportScheduleSettings(),
      { now: new Date('2026-11-16T00:10:00Z'), emailConfigured: true, driveConfigured: false }
    );
    assert.equal(formatted.lastDigestStatus, 'sent');
    assert.equal(formatted.saveToDrive, false);
    assert.equal(formatted.driveConfigured, false);
    assert.equal(formatted.nextRunAt, '2026-11-17T00:00:00.000Z');
  });

  await t.test('scheduler: gagal kirim dicoba ulang lalu berhenti setelah batas percobaan', async () => {
    const emailConfigured = () => true;
    let attempts = 0;
    const failing = async () => {
      attempts += 1;
      throw new Error('SMTP down');
    };
    const now = new Date('2026-11-17T00:05:00Z');

    const first = await runReportIfDue({ now, send: failing, emailConfigured });
    assert.equal(first.status, 'failed_will_retry');
    const second = await runReportIfDue({ now, send: failing, emailConfigured });
    assert.equal(second.status, 'failed_will_retry');
    const third = await runReportIfDue({ now, send: failing, emailConfigured });
    assert.equal(third.status, 'failed');
    const fourth = await runReportIfDue({ now, send: failing, emailConfigured });
    assert.equal(fourth.executed, false);
    assert.equal(attempts, 3);
  });

  await t.test('HTTP /api/notifications/report/settings: RBAC dan validasi', async () => {
    const [owner, kasir] = await User.create([
      { nama: 'Owner Http', username: `own_rh_${Date.now()}`, password: 'x', role: 'pemilik' },
      { nama: 'Kasir Http', username: `ksr_rh_${Date.now()}`, password: 'x', role: 'kasir' },
    ]);
    const ownerToken = jwt.sign({ id: owner._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const kasirToken = jwt.sign({ id: kasir._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/notifications/report/settings`;

    async function req(method, { token, body } = {}) {
      const headers = { Connection: 'close' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }

    assert.equal((await req('GET')).status, 401);
    assert.equal((await req('GET', { token: kasirToken })).status, 403);

    const got = await req('GET', { token: ownerToken });
    assert.equal(got.status, 200, JSON.stringify(got.json));
    assert.equal(typeof got.json.data.saveToDrive, 'boolean');
    assert.equal(typeof got.json.data.driveConfigured, 'boolean');

    const invalid = await req('PUT', { token: ownerToken, body: { digestFrequency: 'yearly' } });
    assert.equal(invalid.status, 400);

    const updated = await req('PUT', {
      token: ownerToken,
      body: { digestFrequency: 'weekly', digestWeekday: 1, digestTime: '08:00', saveToDrive: true },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.data.digestFrequency, 'weekly');
    assert.equal(updated.json.data.saveToDrive, true);

    // Unduh PDF laporan: hanya pemilik, respons berupa file PDF
    const pdfUrl = `http://127.0.0.1:${server.address().port}/api/reports/pdf?tanggalMulai=2026-11-10&tanggalAkhir=2026-11-16`;
    const kasirPdf = await fetch(pdfUrl, { headers: { Authorization: `Bearer ${kasirToken}`, Connection: 'close' } });
    assert.equal(kasirPdf.status, 403);
    await kasirPdf.arrayBuffer();

    const ownerPdf = await fetch(pdfUrl, { headers: { Authorization: `Bearer ${ownerToken}`, Connection: 'close' } });
    assert.equal(ownerPdf.status, 200);
    assert.equal(ownerPdf.headers.get('content-type'), 'application/pdf');
    assert.match(ownerPdf.headers.get('content-disposition'), /Laporan_Stockart_2026-11-10_2026-11-16\.pdf/);
    const pdfBytes = Buffer.from(await ownerPdf.arrayBuffer());
    assert.equal(pdfBytes.subarray(0, 5).toString('latin1'), '%PDF-');

    const badPdf = await fetch(
      `http://127.0.0.1:${server.address().port}/api/reports/pdf?tanggalMulai=2026-02-30`,
      { headers: { Authorization: `Bearer ${ownerToken}`, Connection: 'close' } }
    );
    assert.equal(badPdf.status, 400);
    await badPdf.arrayBuffer();
  });
});
