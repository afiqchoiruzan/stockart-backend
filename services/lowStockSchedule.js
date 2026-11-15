'use strict';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const VALID_FREQUENCIES = ['off', 'daily', 'weekly', 'monthly'];

/**
 * Mengonversi komponen waktu WIB (year, month 0-11, day 1-31, hour, minute)
 * menjadi objek Date UTC yang presisi (WIB tetap UTC+7 tanpa DST).
 */
function wibDateFromParts({ year, month, day, hour, minute }) {
  return new Date(Date.UTC(year, month, day, hour, minute, 0, 0) - WIB_OFFSET_MS);
}

/**
 * Memecah objek Date UTC menjadi komponen kalender & jam di zona waktu WIB.
 */
function getWibParts(date) {
  const ms = new Date(date).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error('Tanggal referensi tidak valid');
  }
  const wib = new Date(ms + WIB_OFFSET_MS);
  return {
    nowMs: ms,
    year: wib.getUTCFullYear(),
    month: wib.getUTCMonth(),
    day: wib.getUTCDate(),
    weekday: wib.getUTCDay(),
  };
}

/**
 * Mem-parsing string jam "HH:mm" menjadi { hour, minute }.
 */
function parseDigestTime(value) {
  if (typeof value !== 'string') {
    throw new Error('digestTime harus berupa string berformat HH:mm');
  }
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    throw new Error('digestTime harus berformat HH:mm (00:00 sampai 23:59)');
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

/**
 * Menghitung slot jadwal terakhir (<= now) dalam UTC Date sesuai pengaturan WIB.
 * Mengembalikan null bila digestFrequency === 'off'.
 */
function getLastOccurrence(settings, now = new Date()) {
  if (!settings || settings.digestFrequency === 'off') {
    return null;
  }

  const frequency = settings.digestFrequency;
  if (!VALID_FREQUENCIES.includes(frequency)) {
    throw new Error(`digestFrequency tidak valid: ${frequency}`);
  }

  const { hour, minute } = parseDigestTime(settings.digestTime || '07:00');
  const { nowMs, year, month, day, weekday } = getWibParts(now);

  if (frequency === 'daily') {
    const candidate = wibDateFromParts({ year, month, day, hour, minute });
    if (candidate.getTime() <= nowMs) return candidate;
    return wibDateFromParts({ year, month, day: day - 1, hour, minute });
  }

  if (frequency === 'weekly') {
    const targetWeekday = Number(settings.digestWeekday ?? 1);
    if (!Number.isInteger(targetWeekday) || targetWeekday < 0 || targetWeekday > 6) {
      throw new Error(`digestWeekday tidak valid: ${settings.digestWeekday}`);
    }
    const daysSinceTarget = (weekday - targetWeekday + 7) % 7;
    const candidate = wibDateFromParts({
      year,
      month,
      day: day - daysSinceTarget,
      hour,
      minute,
    });
    if (candidate.getTime() <= nowMs) return candidate;
    return wibDateFromParts({
      year,
      month,
      day: day - daysSinceTarget - 7,
      hour,
      minute,
    });
  }

  // monthly (digestDayOfMonth 1..28 agar aman di bulan Februari)
  const targetDay = Number(settings.digestDayOfMonth ?? 1);
  if (!Number.isInteger(targetDay) || targetDay < 1 || targetDay > 28) {
    throw new Error(`digestDayOfMonth tidak valid: ${settings.digestDayOfMonth}`);
  }
  const candidate = wibDateFromParts({ year, month, day: targetDay, hour, minute });
  if (candidate.getTime() <= nowMs) return candidate;
  return wibDateFromParts({ year, month: month - 1, day: targetDay, hour, minute });
}

/**
 * Menghitung slot jadwal berikutnya (> now) dalam UTC Date sesuai pengaturan WIB.
 * Mengembalikan null bila digestFrequency === 'off'.
 */
function getNextOccurrence(settings, now = new Date()) {
  if (!settings || settings.digestFrequency === 'off') {
    return null;
  }

  const frequency = settings.digestFrequency;
  if (!VALID_FREQUENCIES.includes(frequency)) {
    throw new Error(`digestFrequency tidak valid: ${frequency}`);
  }

  const { hour, minute } = parseDigestTime(settings.digestTime || '07:00');
  const { nowMs, year, month, day, weekday } = getWibParts(now);

  if (frequency === 'daily') {
    const candidate = wibDateFromParts({ year, month, day, hour, minute });
    if (candidate.getTime() > nowMs) return candidate;
    return wibDateFromParts({ year, month, day: day + 1, hour, minute });
  }

  if (frequency === 'weekly') {
    const targetWeekday = Number(settings.digestWeekday ?? 1);
    if (!Number.isInteger(targetWeekday) || targetWeekday < 0 || targetWeekday > 6) {
      throw new Error(`digestWeekday tidak valid: ${settings.digestWeekday}`);
    }
    const daysUntilTarget = (targetWeekday - weekday + 7) % 7;
    const candidate = wibDateFromParts({
      year,
      month,
      day: day + daysUntilTarget,
      hour,
      minute,
    });
    if (candidate.getTime() > nowMs) return candidate;
    return wibDateFromParts({
      year,
      month,
      day: day + daysUntilTarget + 7,
      hour,
      minute,
    });
  }

  const targetDay = Number(settings.digestDayOfMonth ?? 1);
  if (!Number.isInteger(targetDay) || targetDay < 1 || targetDay > 28) {
    throw new Error(`digestDayOfMonth tidak valid: ${settings.digestDayOfMonth}`);
  }
  const candidate = wibDateFromParts({ year, month, day: targetDay, hour, minute });
  if (candidate.getTime() > nowMs) return candidate;
  return wibDateFromParts({ year, month: month + 1, day: targetDay, hour, minute });
}

/**
 * Menentukan apakah digest perlu dijalankan pada waktu `now`.
 * Due jika slot terakhir lebih baru dari `scheduleActivatedAt` dan `lastDigestOccurrence`.
 */
function isDigestDue(settings, now = new Date()) {
  const occurrence = getLastOccurrence(settings, now);
  if (!occurrence) {
    return { due: false, occurrence: null };
  }

  const occMs = occurrence.getTime();
  const activatedAtMs = settings.scheduleActivatedAt
    ? new Date(settings.scheduleActivatedAt).getTime()
    : 0;
  if (Number.isFinite(activatedAtMs) && occMs <= activatedAtMs) {
    return { due: false, occurrence };
  }

  const lastOccMs = settings.lastDigestOccurrence
    ? new Date(settings.lastDigestOccurrence).getTime()
    : 0;
  if (Number.isFinite(lastOccMs) && occMs <= lastOccMs) {
    return { due: false, occurrence };
  }

  return { due: true, occurrence };
}

module.exports = {
  WIB_OFFSET_MS,
  VALID_FREQUENCIES,
  parseDigestTime,
  getLastOccurrence,
  getNextOccurrence,
  isDigestDue,
};
