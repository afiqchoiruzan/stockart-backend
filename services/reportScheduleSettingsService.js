'use strict';

const NotificationSetting = require('../models/NotificationSetting');
const { getNextOccurrence } = require('./lowStockSchedule');
const { validateSettingsPayload } = require('./lowStockSettingsService');
const { isEmailConfigured } = require('./emailService');

// Pengaturan kirim laporan otomatis disimpan sebagai dokumen singleton terpisah
// di koleksi NotificationSetting, memakai field jadwal yang sama dengan digest low stock.
const REPORT_SETTINGS_KEY = 'reportAutoSend';
const REPORT_SCHEDULE_FIELDS = ['digestFrequency', 'digestTime', 'digestWeekday', 'digestDayOfMonth'];
const REPORT_ALLOWED_FIELDS = [...REPORT_SCHEDULE_FIELDS, 'saveToDrive'];

// Default aman: nonaktif sampai owner mengaktifkannya dari halaman Laporan
const REPORT_DEFAULT_SETTINGS = {
  digestFrequency: 'off',
  digestTime: '07:00',
  digestWeekday: 1,
  digestDayOfMonth: 1,
  saveToDrive: true,
};

function isDriveConfigured(env = process.env) {
  return Boolean(String(env.GDRIVE_WEBHOOK_URL || '').trim());
}

/**
 * Memvalidasi payload pembaruan jadwal laporan (mendukung update parsial).
 * Field jadwal divalidasi dengan aturan yang sama seperti jadwal digest low stock.
 */
function validateReportSettingsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Body permintaan harus berupa objek JSON'], updates: {} };
  }

  const keys = Object.keys(payload);
  if (keys.length === 0) {
    return {
      valid: false,
      errors: ['Minimal satu pengaturan harus dikirim untuk diperbarui'],
      updates: {},
    };
  }

  const errors = [];
  const updates = {};

  for (const key of keys) {
    if (!REPORT_ALLOWED_FIELDS.includes(key)) {
      errors.push(`Field "${key}" tidak diizinkan`);
    }
  }

  const schedulePayload = {};
  for (const field of REPORT_SCHEDULE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      schedulePayload[field] = payload[field];
    }
  }
  if (Object.keys(schedulePayload).length > 0) {
    const result = validateSettingsPayload(schedulePayload);
    errors.push(...result.errors);
    Object.assign(updates, result.updates);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'saveToDrive')) {
    if (typeof payload.saveToDrive !== 'boolean') {
      errors.push('saveToDrive harus berupa boolean (true/false)');
    } else {
      updates.saveToDrive = payload.saveToDrive;
    }
  }

  return { valid: errors.length === 0, errors, updates };
}

/**
 * Mengambil dokumen pengaturan laporan otomatis, atau membuatnya atomik dari default.
 */
async function getReportScheduleSettings(now = new Date()) {
  try {
    return await NotificationSetting.findOneAndUpdate(
      { key: REPORT_SETTINGS_KEY },
      {
        $setOnInsert: {
          key: REPORT_SETTINGS_KEY,
          ...REPORT_DEFAULT_SETTINGS,
          scheduleActivatedAt: now,
        },
      },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );
  } catch (err) {
    // Antisipasi race condition langka pada upsert awal dokumen singleton
    if (err && err.code === 11000) {
      const existing = await NotificationSetting.findOne({ key: REPORT_SETTINGS_KEY });
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Memperbarui pengaturan laporan otomatis secara parsial.
 * Hanya mereset `scheduleActivatedAt` & `digestAttempts` jika nilai field jadwal berubah,
 * sehingga slot yang sudah lewat tidak langsung terkirim setelah jadwal diubah.
 */
async function updateReportScheduleSettings(
  payload,
  now = new Date(),
  { emailConfigured = isEmailConfigured } = {}
) {
  const { valid, errors, updates } = validateReportSettingsPayload(payload);
  if (!valid) {
    throw Object.assign(new Error(errors.join('; ')), {
      statusCode: 400,
      errors,
    });
  }

  const current = await getReportScheduleSettings(now);
  const scheduleChanged = REPORT_SCHEDULE_FIELDS.some(
    (field) =>
      Object.prototype.hasOwnProperty.call(updates, field) &&
      updates[field] !== current[field]
  );

  const setFields = { ...updates };
  if (scheduleChanged) {
    setFields.scheduleActivatedAt = now;
    setFields.digestAttempts = 0;
    setFields.lastAttemptOccurrence = null;
  }

  if (current.lastDigestStatus === 'email_not_configured' && emailConfigured()) {
    setFields.lastDigestStatus = null;
    setFields.lastDigestError = null;
  }

  return NotificationSetting.findOneAndUpdate(
    { key: REPORT_SETTINGS_KEY },
    { $set: setFields },
    { returnDocument: 'after', runValidators: true }
  );
}

/**
 * Memformat dokumen pengaturan laporan otomatis untuk respons API.
 */
function formatReportSettingsResponse(
  doc,
  { now = new Date(), emailConfigured = isEmailConfigured(), driveConfigured = isDriveConfigured() } = {}
) {
  const nextRun = getNextOccurrence(doc, now);
  const configured = Boolean(emailConfigured);
  const staleUnconfigured = configured && doc.lastDigestStatus === 'email_not_configured';

  return {
    digestFrequency: doc.digestFrequency,
    digestTime: doc.digestTime,
    digestWeekday: doc.digestWeekday,
    digestDayOfMonth: doc.digestDayOfMonth,
    saveToDrive: doc.saveToDrive !== false,
    scheduleActivatedAt: doc.scheduleActivatedAt,
    nextRunAt: nextRun ? nextRun.toISOString() : null,
    lastDigestOccurrence: doc.lastDigestOccurrence || null,
    lastDigestSentAt: doc.lastDigestSentAt || null,
    lastDigestStatus: staleUnconfigured ? null : (doc.lastDigestStatus || null),
    lastDigestError: staleUnconfigured ? null : (doc.lastDigestError || null),
    digestAttempts: doc.digestAttempts ?? 0,
    emailConfigured: configured,
    driveConfigured: Boolean(driveConfigured),
  };
}

module.exports = {
  REPORT_SETTINGS_KEY,
  REPORT_SCHEDULE_FIELDS,
  REPORT_ALLOWED_FIELDS,
  REPORT_DEFAULT_SETTINGS,
  isDriveConfigured,
  validateReportSettingsPayload,
  getReportScheduleSettings,
  updateReportScheduleSettings,
  formatReportSettingsResponse,
};
