'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
require('dotenv').config();

const NotificationSetting = require('../models/NotificationSetting');
const {
  getDefaultSettingsFromEnv,
  validateSettingsPayload,
  getLowStockSettings,
  updateLowStockSettings,
  formatSettingsResponse,
} = require('../services/lowStockSettingsService');

test('validateSettingsPayload: validasi ketat tanpa DB', () => {
  assert.deepEqual(
    validateSettingsPayload({
      digestFrequency: 'monthly',
      digestTime: '08:30',
      digestDayOfMonth: 15,
      criticalAlertEnabled: false,
    }),
    {
      valid: true,
      errors: [],
      updates: {
        digestFrequency: 'monthly',
        digestTime: '08:30',
        digestDayOfMonth: 15,
        criticalAlertEnabled: false,
      },
    }
  );

  const invalidPayloads = [
    null,
    [],
    {},
    { unknownField: 123 },
    { digestFrequency: 'hourly' },
    { digestTime: '9:00' },
    { digestTime: '25:00' },
    { digestWeekday: -1 },
    { digestWeekday: 7 },
    { digestWeekday: 1.5 },
    { digestWeekday: '1' },
    { digestDayOfMonth: 0 },
    { digestDayOfMonth: 29 },
    { digestDayOfMonth: 31 },
    { criticalAlertEnabled: 'true' },
  ];

  for (const payload of invalidPayloads) {
    const res = validateSettingsPayload(payload);
    assert.equal(res.valid, false, `Seharusnya invalid: ${JSON.stringify(payload)}`);
    assert.ok(res.errors.length > 0);
  }
});

test('getDefaultSettingsFromEnv: fallback aman saat env tidak lengkap/invalid', () => {
  assert.deepEqual(getDefaultSettingsFromEnv({}), {
    digestFrequency: 'weekly',
    digestTime: '07:00',
    digestWeekday: 1,
    digestDayOfMonth: 1,
    criticalAlertEnabled: true,
  });

  assert.deepEqual(
    getDefaultSettingsFromEnv({
      LOW_STOCK_DIGEST_FREQUENCY: 'daily',
      LOW_STOCK_DIGEST_TIME: '18:45',
      LOW_STOCK_DIGEST_WEEKDAY: '5',
      LOW_STOCK_DIGEST_DAY_OF_MONTH: '20',
      LOW_STOCK_CRITICAL_ALERT_ENABLED: 'false',
    }),
    {
      digestFrequency: 'daily',
      digestTime: '18:45',
      digestWeekday: 5,
      digestDayOfMonth: 20,
      criticalAlertEnabled: false,
    }
  );
});

test('NotificationSetting persistence: get-or-create konkuren & pembaruan parsial', async (t) => {
  const dbName = `t_set_${process.pid}_${Date.now().toString(36)}`;
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });
  t.after(async () => {
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

  await NotificationSetting.syncIndexes();

  // Panggil paralel 5x -> tetap cuma 1 dokumen singleton
  const t0 = new Date('2026-11-15T00:00:00Z');
  const results = await Promise.all(Array.from({ length: 5 }, () => getLowStockSettings(t0)));
  assert.equal(results.length, 5);
  assert.equal(await NotificationSetting.countDocuments(), 1);
  assert.equal(results[0].digestFrequency, 'weekly');
  assert.equal(results[0].digestTime, '07:00');
  assert.equal(results[0].digestWeekday, 1);
  assert.equal(results[0].criticalAlertEnabled, true);

  // Simulasi sudah ada riwayat attempts sebelumnya
  await NotificationSetting.updateOne(
    { key: 'lowStockAlert' },
    { $set: { digestAttempts: 2 } }
  );

  // Update criticalAlertEnabled saja -> scheduleActivatedAt & digestAttempts TIDAK berubah
  const t1 = new Date('2026-11-15T01:00:00Z');
  const afterCritOnly = await updateLowStockSettings({ criticalAlertEnabled: false }, t1);
  assert.equal(afterCritOnly.criticalAlertEnabled, false);
  assert.equal(new Date(afterCritOnly.scheduleActivatedAt).toISOString(), t0.toISOString());
  assert.equal(afterCritOnly.digestAttempts, 2);

  // Update dengan nilai jadwal identik + criticalAlertEnabled -> scheduleActivatedAt tetap tidak berubah
  const t2 = new Date('2026-11-15T02:00:00Z');
  const afterSameSchedule = await updateLowStockSettings(
    {
      digestFrequency: 'weekly',
      digestTime: '07:00',
      digestWeekday: 1,
      digestDayOfMonth: 1,
      criticalAlertEnabled: true,
    },
    t2
  );
  assert.equal(afterSameSchedule.criticalAlertEnabled, true);
  assert.equal(new Date(afterSameSchedule.scheduleActivatedAt).toISOString(), t0.toISOString());
  assert.equal(afterSameSchedule.digestAttempts, 2);

  // Update field jadwal ke nilai baru -> scheduleActivatedAt diperbarui & digestAttempts reset ke 0
  const t3 = new Date('2026-11-15T03:00:00Z');
  const afterScheduleChange = await updateLowStockSettings(
    { digestFrequency: 'daily', digestTime: '09:15' },
    t3
  );
  assert.equal(afterScheduleChange.digestFrequency, 'daily');
  assert.equal(afterScheduleChange.digestTime, '09:15');
  assert.equal(new Date(afterScheduleChange.scheduleActivatedAt).toISOString(), t3.toISOString());
  assert.equal(afterScheduleChange.digestAttempts, 0);

  const formatted = formatSettingsResponse(afterScheduleChange, {
    now: new Date('2026-11-15T03:00:00Z'), // 10:00 WIB -> next daily 09:15 WIB = 16 Nov 02:15Z
    emailConfigured: true,
  });
  assert.equal(formatted.nextRunAt, '2026-11-16T02:15:00.000Z');
  assert.equal(formatted.emailConfigured, true);

  // Simulasi status usang 'email_not_configured' saat konfigurasi email kini sudah aktif
  await NotificationSetting.updateOne(
    { key: 'lowStockAlert' },
    {
      $set: {
        lastDigestStatus: 'email_not_configured',
        lastDigestError: 'Konfigurasi email belum diatur',
      },
    }
  );
  const staleDoc = await NotificationSetting.findOne({ key: 'lowStockAlert' });
  const hiddenWhenConfigured = formatSettingsResponse(staleDoc, {
    now: t3,
    emailConfigured: true,
  });
  assert.equal(hiddenWhenConfigured.emailConfigured, true);
  assert.equal(hiddenWhenConfigured.lastDigestStatus, null);
  assert.equal(hiddenWhenConfigured.lastDigestError, null);

  const shownWhenUnconfigured = formatSettingsResponse(staleDoc, {
    now: t3,
    emailConfigured: false,
  });
  assert.equal(shownWhenUnconfigured.lastDigestStatus, 'email_not_configured');

  // Update pengaturan saat emailConfigured=true membersihkan status usang di DB
  const cleanedDoc = await updateLowStockSettings(
    { digestFrequency: 'monthly', digestDayOfMonth: 1 },
    new Date('2026-11-15T04:00:00Z'),
    { emailConfigured: () => true }
  );
  assert.equal(cleanedDoc.lastDigestStatus, null);
  assert.equal(cleanedDoc.lastDigestError, null);
});
