'use strict';

const NotificationSetting = require('../models/NotificationSetting');
const { isEmailConfigured } = require('./emailService');
const { WIB_OFFSET_MS, isDigestDue } = require('./lowStockSchedule');
const { sendReport } = require('./reportService');
const {
  REPORT_SETTINGS_KEY,
  getReportScheduleSettings,
} = require('./reportScheduleSettingsService');

const MAX_REPORT_ATTEMPTS = 3;
const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;

let schedulerTimer = null;
let activeTickPromise = null;

/** Date UTC -> "YYYY-MM-DD" dalam kalender WIB. */
function toWibDateKey(date) {
  return new Date(new Date(date).getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" + n hari -> "YYYY-MM-DD". */
function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" mundur satu bulan pada tanggal yang sama (digestDayOfMonth maks 28). */
function shiftMonthBack(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Menentukan rentang laporan untuk satu slot jadwal. Laporan selalu mencakup
 * hari-hari penuh sebelum tanggal slot (WIB):
 * - daily   -> kemarin
 * - weekly  -> 7 hari terakhir sampai kemarin
 * - monthly -> sejak tanggal yang sama bulan lalu sampai kemarin
 */
function getReportPeriodForOccurrence(frequency, occurrence) {
  const slotDate = toWibDateKey(occurrence);
  const tanggalAkhir = shiftDateKey(slotDate, -1);

  if (frequency === 'weekly') {
    return { tanggalMulai: shiftDateKey(slotDate, -7), tanggalAkhir };
  }
  if (frequency === 'monthly') {
    return { tanggalMulai: shiftMonthBack(slotDate), tanggalAkhir };
  }
  return { tanggalMulai: tanggalAkhir, tanggalAkhir };
}

/**
 * Satu siklus tick scheduler dengan guard anti-overlap (re-entrancy).
 */
async function runReportSchedulerTick(options = {}) {
  if (activeTickPromise) {
    return { executed: false, reason: 'tick_in_progress' };
  }
  const run = (async () => {
    try {
      return await runReportIfDue(options);
    } catch (err) {
      console.error('[ReportScheduler] Error tick:', err.message);
      return { executed: false, reason: 'error', error: err.message };
    } finally {
      activeTickPromise = null;
    }
  })();
  activeTickPromise = run;
  return run;
}

/**
 * Menunggu tick scheduler yang sedang berjalan hingga selesai (bermanfaat untuk test).
 */
async function waitForReportSchedulerIdle() {
  if (activeTickPromise) {
    await activeTickPromise;
  }
}

/**
 * Mengirim laporan otomatis jika slot jadwal saat ini sudah jatuh tempo.
 * Menggunakan klaim atomik di MongoDB sehingga tahan terhadap restart dan eksekusi paralel.
 */
async function runReportIfDue({
  now = new Date(),
  send = sendReport,
  emailConfigured = isEmailConfigured,
} = {}) {
  const settings = await getReportScheduleSettings(now);
  if (settings.lastDigestStatus === 'email_not_configured' && emailConfigured()) {
    await NotificationSetting.updateOne(
      { key: REPORT_SETTINGS_KEY, lastDigestStatus: 'email_not_configured' },
      { $set: { lastDigestStatus: null, lastDigestError: null } }
    );
    settings.lastDigestStatus = null;
    settings.lastDigestError = null;
  }
  const { due, occurrence } = isDigestDue(settings, now);

  if (!due || !occurrence) {
    return {
      executed: false,
      reason: settings.digestFrequency === 'off' ? 'off' : 'not_due',
      occurrence,
    };
  }

  // Klaim slot secara atomik sebelum menyusun dan mengirim laporan
  const claimed = await NotificationSetting.findOneAndUpdate(
    {
      key: REPORT_SETTINGS_KEY,
      digestFrequency: settings.digestFrequency,
      $or: [
        { lastDigestOccurrence: null },
        { lastDigestOccurrence: { $lt: occurrence } },
      ],
    },
    {
      $set: {
        lastDigestOccurrence: occurrence,
        lastAttemptOccurrence: occurrence,
      },
    },
    { returnDocument: 'before' }
  );

  if (!claimed) {
    return { executed: false, reason: 'already_claimed', occurrence };
  }

  const sameAttemptSlot =
    claimed.lastAttemptOccurrence &&
    new Date(claimed.lastAttemptOccurrence).getTime() === occurrence.getTime();
  const currentAttempt = sameAttemptSlot ? Number(claimed.digestAttempts || 0) + 1 : 1;

  if (!emailConfigured()) {
    await NotificationSetting.updateOne(
      { key: REPORT_SETTINGS_KEY },
      {
        $set: {
          lastDigestStatus: 'email_not_configured',
          lastDigestError: 'Konfigurasi email (BREVO_API_KEY atau SMTP_USER/SMTP_PASS) belum diatur',
          digestAttempts: currentAttempt,
          lastAttemptOccurrence: occurrence,
        },
      }
    );
    return {
      executed: true,
      status: 'email_not_configured',
      attempts: currentAttempt,
      occurrence,
    };
  }

  const period = getReportPeriodForOccurrence(claimed.digestFrequency, occurrence);

  try {
    await send({
      ...period,
      saveToDrive: claimed.saveToDrive !== false,
      context: 'scheduled',
      frequency: claimed.digestFrequency,
    });

    await NotificationSetting.updateOne(
      { key: REPORT_SETTINGS_KEY },
      {
        $set: {
          lastDigestSentAt: new Date(now),
          lastDigestStatus: 'sent',
          lastDigestError: null,
          digestAttempts: currentAttempt,
          lastAttemptOccurrence: occurrence,
        },
      }
    );

    return {
      executed: true,
      status: 'sent',
      attempts: currentAttempt,
      period,
      occurrence,
    };
  } catch (err) {
    const errorMessage = err && err.message ? String(err.message) : 'Gagal mengirim laporan otomatis';
    const shouldRetry = currentAttempt < MAX_REPORT_ATTEMPTS;

    await NotificationSetting.updateOne(
      { key: REPORT_SETTINGS_KEY },
      {
        $set: {
          lastDigestOccurrence: shouldRetry
            ? claimed.lastDigestOccurrence || null
            : occurrence,
          lastDigestStatus: 'failed',
          lastDigestError: errorMessage,
          digestAttempts: currentAttempt,
          lastAttemptOccurrence: occurrence,
        },
      }
    );

    return {
      executed: true,
      status: shouldRetry ? 'failed_will_retry' : 'failed',
      attempts: currentAttempt,
      error: errorMessage,
      period,
      occurrence,
    };
  }
}

/**
 * Memulai background interval scheduler untuk laporan otomatis.
 * Langsung menjalankan tick awal saat start untuk catch-up jadwal yang terlewat.
 */
function startReportScheduler({ intervalMs, ...runnerOptions } = {}) {
  if (process.env.REPORT_SCHEDULER_ENABLED === 'false') {
    return null;
  }
  if (schedulerTimer) {
    return schedulerTimer;
  }

  const parsed = Number(intervalMs ?? process.env.REPORT_SCHEDULER_INTERVAL_MS);
  const effectiveInterval =
    Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_TICK_INTERVAL_MS;

  runReportSchedulerTick(runnerOptions);

  schedulerTimer = setInterval(() => {
    runReportSchedulerTick(runnerOptions);
  }, effectiveInterval);

  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }

  console.log(`[ReportScheduler] Aktif (interval pengecekan ${effectiveInterval} ms)`);
  return schedulerTimer;
}

/**
 * Menghentikan background scheduler laporan otomatis.
 */
function stopReportScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  MAX_REPORT_ATTEMPTS,
  getReportPeriodForOccurrence,
  runReportIfDue,
  runReportSchedulerTick,
  waitForReportSchedulerIdle,
  startReportScheduler,
  stopReportScheduler,
};
