'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
require('dotenv').config();

const Product = require('../models/Product');
const NotificationSetting = require('../models/NotificationSetting');
const {
  runDigestIfDue,
  waitForSchedulerIdle,
  startLowStockScheduler,
  stopLowStockScheduler,
} = require('../services/lowStockDigestService');

test('Low Stock Digest Runner & Scheduler: atomik, tahan restart, retry, dan filter produk', async (t) => {
  const dbName = `t_dig_${process.pid}_${Date.now().toString(36)}`;
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });
  t.after(async () => {
    stopLowStockScheduler();
    await waitForSchedulerIdle();
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

  await Promise.all([Product.syncIndexes(), NotificationSetting.syncIndexes()]);

  async function resetSettings(overrides = {}) {
    await NotificationSetting.deleteMany({});
    return NotificationSetting.create({
      key: 'lowStockAlert',
      digestFrequency: 'weekly',
      digestTime: '07:00',
      digestWeekday: 1,
      digestDayOfMonth: 1,
      criticalAlertEnabled: true,
      scheduleActivatedAt: new Date('2026-11-01T00:00:00Z'),
      lastDigestOccurrence: null,
      lastDigestSentAt: null,
      lastDigestStatus: null,
      lastDigestCount: 0,
      lastDigestError: null,
      digestAttempts: 0,
      lastAttemptOccurrence: null,
      ...overrides,
    });
  }

  await t.test('1-2-7. Klaim atomik: 5x paralel & simulasi restart hanya kirim 1 email dan kecualikan produk nonaktif', async () => {
    await Product.deleteMany({});
    await Product.create([
      { nama: 'Gula Pasir Low', kodeProduk: 'DIG-1', hargaBeli: 10000, hargaJual: 12000, stok: 2, stokMinimum: 5, aktif: true },
      { nama: 'Minyak Habis', kodeProduk: 'DIG-2', hargaBeli: 20000, hargaJual: 24000, stok: 0, stokMinimum: 3, aktif: true },
      { nama: 'Produk Aman', kodeProduk: 'DIG-3', hargaBeli: 5000, hargaJual: 7000, stok: 20, stokMinimum: 5, aktif: true },
      { nama: 'Produk Nonaktif Low', kodeProduk: 'DIG-4', hargaBeli: 5000, hargaJual: 7000, stok: 1, stokMinimum: 5, aktif: false },
    ]);
    await resetSettings();

    const sentCalls = [];
    const mockSend = async (products, recipient, options) => {
      sentCalls.push({ products, recipient, options });
      return { success: true };
    };

    // Senin 9 Nov 2026 07:05 WIB (slot 07:00 WIB = 2026-11-09T00:00:00Z)
    const mondayMorning = new Date('2026-11-09T00:05:00Z');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runDigestIfDue({
          now: mondayMorning,
          send: mockSend,
          emailConfigured: () => true,
        })
      )
    );

    const executedSent = results.filter((r) => r.status === 'sent');
    assert.equal(executedSent.length, 1);
    assert.equal(sentCalls.length, 1);
    assert.equal(sentCalls[0].options.context, 'digest');
    assert.equal(sentCalls[0].options.frequency, 'weekly');
    assert.deepEqual(
      sentCalls[0].products.map((p) => p.kodeProduk).sort(),
      ['DIG-1', 'DIG-2']
    );

    // Simulasi restart server pada hari yang sama -> tidak kirim ulang
    const afterRestart = await runDigestIfDue({
      now: new Date('2026-11-09T05:00:00Z'),
      send: mockSend,
      emailConfigured: () => true,
    });
    assert.equal(afterRestart.executed, false);
    assert.equal(afterRestart.reason, 'not_due');
    assert.equal(sentCalls.length, 1);

    const saved = await NotificationSetting.findOne({ key: 'lowStockAlert' });
    assert.equal(saved.lastDigestStatus, 'sent');
    assert.equal(saved.lastDigestCount, 2);
    assert.equal(new Date(saved.lastDigestOccurrence).toISOString(), '2026-11-09T00:00:00.000Z');
  });

  await t.test('3. Catch-up setelah server mati saat slot terlewat lalu normal di minggu berikutnya', async () => {
    await resetSettings({
      lastDigestOccurrence: new Date('2026-11-02T00:00:00Z'),
    });

    const sentCalls = [];
    // Server mati saat Senin 9 Nov 07:00 WIB, baru bangun Rabu 11 Nov 10:00 WIB
    const wednesday = new Date('2026-11-11T03:00:00Z');
    const catchUp = await runDigestIfDue({
      now: wednesday,
      send: async (products, _r, opts) => {
        sentCalls.push({ count: products.length, opts });
        return { success: true };
      },
      emailConfigured: () => true,
    });

    assert.equal(catchUp.executed, true);
    assert.equal(catchUp.status, 'sent');
    assert.equal(catchUp.occurrence.toISOString(), '2026-11-09T00:00:00.000Z');
    assert.equal(sentCalls.length, 1);
  });

  await t.test('4. Tidak ada produk low stock -> status skipped_empty, tidak kirim email, slot dianggap selesai', async () => {
    await Product.deleteMany({});
    await Product.create({
      nama: 'Semua Aman',
      kodeProduk: 'SAFE-1',
      hargaBeli: 1000,
      hargaJual: 2000,
      stok: 50,
      stokMinimum: 5,
      aktif: true,
    });
    await resetSettings();

    let sendCount = 0;
    const monday = new Date('2026-11-09T00:05:00Z');
    const first = await runDigestIfDue({
      now: monday,
      send: async () => {
        sendCount += 1;
      },
      emailConfigured: () => true,
    });

    assert.equal(first.executed, true);
    assert.equal(first.status, 'skipped_empty');
    assert.equal(first.count, 0);
    assert.equal(sendCount, 0);

    const second = await runDigestIfDue({
      now: new Date('2026-11-09T01:00:00Z'),
      send: async () => {
        sendCount += 1;
      },
      emailConfigured: () => true,
    });
    assert.equal(second.executed, false);
    assert.equal(second.reason, 'not_due');
    assert.equal(sendCount, 0);
  });

  await t.test('5. Email gagal -> retry maks 3x lalu berhenti (failed); slot minggu baru reset attempts', async () => {
    await Product.deleteMany({});
    await Product.create({
      nama: 'Stok Tipis',
      kodeProduk: 'FAIL-1',
      hargaBeli: 1000,
      hargaJual: 2000,
      stok: 1,
      stokMinimum: 5,
      aktif: true,
    });
    await resetSettings();

    let sendCalls = 0;
    const failingSend = async () => {
      sendCalls += 1;
      throw new Error('Brevo API down');
    };

    const monday1 = new Date('2026-11-09T00:05:00Z');
    const r1 = await runDigestIfDue({ now: monday1, send: failingSend, emailConfigured: () => true });
    assert.equal(r1.status, 'failed_will_retry');
    assert.equal(r1.attempts, 1);

    const r2 = await runDigestIfDue({ now: monday1, send: failingSend, emailConfigured: () => true });
    assert.equal(r2.status, 'failed_will_retry');
    assert.equal(r2.attempts, 2);

    const r3 = await runDigestIfDue({ now: monday1, send: failingSend, emailConfigured: () => true });
    assert.equal(r3.status, 'failed');
    assert.equal(r3.attempts, 3);
    assert.equal(sendCalls, 3);

    // Tick ke-4 pada slot sama TIDAK boleh mengirim lagi
    const r4 = await runDigestIfDue({ now: monday1, send: failingSend, emailConfigured: () => true });
    assert.equal(r4.executed, false);
    assert.equal(r4.reason, 'not_due');
    assert.equal(sendCalls, 3);

    // Minggu berikutnya (Senin 16 Nov 07:05 WIB) harus reset attempts ke 1 dan berhasil
    const monday2 = new Date('2026-11-16T00:05:00Z');
    const rNextWeek = await runDigestIfDue({
      now: monday2,
      send: async () => ({ success: true }),
      emailConfigured: () => true,
    });
    assert.equal(rNextWeek.executed, true);
    assert.equal(rNextWeek.status, 'sent');
    assert.equal(rNextWeek.attempts, 1);
  });

  await t.test('6. Email belum dikonfigurasi -> status email_not_configured tanpa retry dan tanpa panggil send', async () => {
    await resetSettings();
    let sendCalls = 0;
    const monday = new Date('2026-11-09T00:05:00Z');

    const r1 = await runDigestIfDue({
      now: monday,
      send: async () => {
        sendCalls += 1;
      },
      emailConfigured: () => false,
    });
    assert.equal(r1.executed, true);
    assert.equal(r1.status, 'email_not_configured');
    assert.equal(sendCalls, 0);

    const r2 = await runDigestIfDue({
      now: monday,
      send: async () => {
        sendCalls += 1;
      },
      emailConfigured: () => false,
    });
    assert.equal(r2.executed, false);
    assert.equal(r2.reason, 'not_due');

    // Jika kemudian env email aktif dan tick berjalan lagi, status usang 'email_not_configured' dibersihkan
    const r3 = await runDigestIfDue({
      now: new Date('2026-11-09T00:10:00Z'),
      send: async () => {
        sendCalls += 1;
      },
      emailConfigured: () => true,
    });
    assert.equal(r3.executed, false);
    const healedDoc = await NotificationSetting.findOne({ key: 'lowStockAlert' });
    assert.equal(healedDoc.lastDigestStatus, null);
    assert.equal(healedDoc.lastDigestError, null);
  });

  await t.test('8. startLowStockScheduler & stopLowStockScheduler mematuhi toggle dan tidak menyisakan handle', async () => {
    await resetSettings({ digestFrequency: 'off' });
    const prev = process.env.LOW_STOCK_SCHEDULER_ENABLED;
    try {
      process.env.LOW_STOCK_SCHEDULER_ENABLED = 'false';
      assert.equal(startLowStockScheduler({ intervalMs: 5000 }), null);

      delete process.env.LOW_STOCK_SCHEDULER_ENABLED;
      const timer = startLowStockScheduler({
        intervalMs: 60000,
        emailConfigured: () => false,
      });
      assert.ok(timer);
      stopLowStockScheduler();
    } finally {
      if (prev === undefined) delete process.env.LOW_STOCK_SCHEDULER_ENABLED;
      else process.env.LOW_STOCK_SCHEDULER_ENABLED = prev;
    }
  });
});
