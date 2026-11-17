'use strict';

const NotificationSetting = require('../models/NotificationSetting');
const {
  VALID_FREQUENCIES,
  parseDigestTime,
  getNextOccurrence,
} = require('./lowStockSchedule');
const {
  isEmailConfigured,
  getDefaultRecipientLabel,
  maskEmailRecipients,
  validateOptionalEmailRecipients,
} = require('./emailService');

const SETTINGS_KEY = 'lowStockAlert';
const SCHEDULE_FIELDS = ['digestFrequency', 'digestTime', 'digestWeekday', 'digestDayOfMonth'];
const ALLOWED_UPDATE_FIELDS = [...SCHEDULE_FIELDS, 'criticalAlertEnabled', 'recipientEmail'];

/**
 * Mengambil nilai default awal dari environment variable bila valid,
 * atau fallback ke default aman (Mingguan, Senin 07:00 WIB, alert kritis aktif).
 */
function getDefaultSettingsFromEnv(env = process.env) {
  const rawFreq = String(env.LOW_STOCK_DIGEST_FREQUENCY || '').trim().toLowerCase();
  const digestFrequency = VALID_FREQUENCIES.includes(rawFreq) ? rawFreq : 'weekly';

  let digestTime = '07:00';
  if (env.LOW_STOCK_DIGEST_TIME) {
    try {
      parseDigestTime(String(env.LOW_STOCK_DIGEST_TIME));
      digestTime = String(env.LOW_STOCK_DIGEST_TIME).trim();
    } catch {
      // Gunakan fallback 07:00 jika env tidak valid
    }
  }

  const parsedWeekday = Number(env.LOW_STOCK_DIGEST_WEEKDAY);
  const digestWeekday =
    env.LOW_STOCK_DIGEST_WEEKDAY !== undefined &&
    env.LOW_STOCK_DIGEST_WEEKDAY !== '' &&
    Number.isInteger(parsedWeekday) &&
    parsedWeekday >= 0 &&
    parsedWeekday <= 6
      ? parsedWeekday
      : 1;

  const parsedDom = Number(env.LOW_STOCK_DIGEST_DAY_OF_MONTH);
  const digestDayOfMonth =
    env.LOW_STOCK_DIGEST_DAY_OF_MONTH !== undefined &&
    env.LOW_STOCK_DIGEST_DAY_OF_MONTH !== '' &&
    Number.isInteger(parsedDom) &&
    parsedDom >= 1 &&
    parsedDom <= 28
      ? parsedDom
      : 1;

  const rawCrit = String(env.LOW_STOCK_CRITICAL_ALERT_ENABLED ?? 'true').trim().toLowerCase();
  const criticalAlertEnabled = rawCrit !== 'false';

  return {
    digestFrequency,
    digestTime,
    digestWeekday,
    digestDayOfMonth,
    criticalAlertEnabled,
  };
}

/**
 * Memvalidasi payload pembaruan pengaturan notifikasi (mendukung update parsial).
 * Mengembalikan { valid, errors, updates }.
 */
function validateSettingsPayload(payload) {
  const errors = [];
  const updates = {};

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      errors: ['Body permintaan harus berupa objek JSON'],
      updates,
    };
  }

  const keys = Object.keys(payload);
  if (keys.length === 0) {
    return {
      valid: false,
      errors: ['Minimal satu pengaturan harus dikirim untuk diperbarui'],
      updates,
    };
  }

  for (const key of keys) {
    if (!ALLOWED_UPDATE_FIELDS.includes(key)) {
      errors.push(`Field "${key}" tidak diizinkan`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'digestFrequency')) {
    const val = payload.digestFrequency;
    if (typeof val !== 'string' || !VALID_FREQUENCIES.includes(val)) {
      errors.push(`digestFrequency harus salah satu dari: ${VALID_FREQUENCIES.join(', ')}`);
    } else {
      updates.digestFrequency = val;
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'digestTime')) {
    const val = payload.digestTime;
    try {
      parseDigestTime(val);
      updates.digestTime = val.trim();
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'digestWeekday')) {
    const val = payload.digestWeekday;
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 6) {
      errors.push('digestWeekday harus berupa bilangan bulat 0 (Minggu) sampai 6 (Sabtu)');
    } else {
      updates.digestWeekday = val;
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'digestDayOfMonth')) {
    const val = payload.digestDayOfMonth;
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 28) {
      errors.push('digestDayOfMonth harus berupa bilangan bulat 1 sampai 28');
    } else {
      updates.digestDayOfMonth = val;
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'criticalAlertEnabled')) {
    const val = payload.criticalAlertEnabled;
    if (typeof val !== 'boolean') {
      errors.push('criticalAlertEnabled harus berupa boolean (true/false)');
    } else {
      updates.criticalAlertEnabled = val;
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'recipientEmail')) {
    const check = validateOptionalEmailRecipients(payload.recipientEmail);
    if (!check.valid) {
      errors.push(check.message);
    } else {
      updates.recipientEmail = check.normalized || null;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    updates,
  };
}

/**
 * Mengambil dokumen pengaturan singleton dari database, atau membuatnya atomik
 * dari nilai default env jika belum ada.
 */
async function getLowStockSettings(now = new Date()) {
  const defaults = getDefaultSettingsFromEnv();
  try {
    return await NotificationSetting.findOneAndUpdate(
      { key: SETTINGS_KEY },
      {
        $setOnInsert: {
          key: SETTINGS_KEY,
          ...defaults,
          scheduleActivatedAt: now,
        },
      },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );
  } catch (err) {
    // Antisipasi race condition langka pada upsert awal dokumen singleton
    if (err && err.code === 11000) {
      const existing = await NotificationSetting.findOne({ key: SETTINGS_KEY });
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Memperbarui pengaturan notifikasi secara parsial.
 * Hanya mereset `scheduleActivatedAt` & `digestAttempts` jika nilai field jadwal berubah.
 */
async function updateLowStockSettings(
  payload,
  now = new Date(),
  { emailConfigured = isEmailConfigured } = {}
) {
  const { valid, errors, updates } = validateSettingsPayload(payload);
  if (!valid) {
    throw Object.assign(new Error(errors.join('; ')), {
      statusCode: 400,
      errors,
    });
  }

  const current = await getLowStockSettings(now);
  const scheduleChanged = SCHEDULE_FIELDS.some(
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

  // Bersihkan status usang 'email_not_configured' bila konfigurasi email saat ini sudah aktif
  if (current.lastDigestStatus === 'email_not_configured' && emailConfigured()) {
    setFields.lastDigestStatus = null;
    setFields.lastDigestError = null;
  }

  return NotificationSetting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: setFields },
    { returnDocument: 'after', runValidators: true }
  );
}

/**
 * Memformat dokumen pengaturan untuk respons API (termasuk nextRunAt & status email).
 */
function formatSettingsResponse(
  doc,
  {
    now = new Date(),
    emailConfigured = isEmailConfigured(),
    defaultRecipient = getDefaultRecipientLabel(),
  } = {}
) {
  const nextRun = getNextOccurrence(doc, now);
  const configured = Boolean(emailConfigured);
  const staleUnconfigured = configured && doc.lastDigestStatus === 'email_not_configured';
  const customRecipient = String(doc.recipientEmail || '').trim();
  const effectiveRecipient = customRecipient || defaultRecipient;

  return {
    digestFrequency: doc.digestFrequency,
    digestTime: doc.digestTime,
    digestWeekday: doc.digestWeekday,
    digestDayOfMonth: doc.digestDayOfMonth,
    criticalAlertEnabled: Boolean(doc.criticalAlertEnabled),
    scheduleActivatedAt: doc.scheduleActivatedAt,
    nextRunAt: nextRun ? nextRun.toISOString() : null,
    lastDigestOccurrence: doc.lastDigestOccurrence || null,
    lastDigestSentAt: doc.lastDigestSentAt || null,
    lastDigestStatus: staleUnconfigured ? null : (doc.lastDigestStatus || null),
    lastDigestCount: doc.lastDigestCount ?? 0,
    lastDigestError: staleUnconfigured ? null : (doc.lastDigestError || null),
    digestAttempts: doc.digestAttempts ?? 0,
    emailConfigured: configured,
    maskedRecipient: maskEmailRecipients(effectiveRecipient),
    isCustomRecipient: Boolean(customRecipient),
  };
}

module.exports = {
  SETTINGS_KEY,
  SCHEDULE_FIELDS,
  ALLOWED_UPDATE_FIELDS,
  getDefaultSettingsFromEnv,
  validateSettingsPayload,
  getLowStockSettings,
  updateLowStockSettings,
  formatSettingsResponse,
};
