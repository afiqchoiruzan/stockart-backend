'use strict';

const NotificationSetting = require('../models/NotificationSetting');
const Product = require('../models/Product');
const { isEmailConfigured, sendLowStockAlertEmail } = require('./emailService');
const { isDigestDue } = require('./lowStockSchedule');
const { SETTINGS_KEY, getLowStockSettings } = require('./lowStockSettingsService');

const MAX_DIGEST_ATTEMPTS = 3;
const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;

let schedulerTimer = null;
let activeTickPromise = null;

/**
 * Satu siklus tick scheduler dengan guard anti-overlap (re-entrancy).
 */
async function runSchedulerTick(options = {}) {
  if (activeTickPromise) {
    return { executed: false, reason: 'tick_in_progress' };
  }
  const run = (async () => {
    try {
      return await runDigestIfDue(options);
    } catch (err) {
      console.error('[LowStockScheduler] Error tick:', err.message);
      return { executed: false, reason: 'error', error: err.message };
    } finally {
      activeTickPromise = null;
    }
  })();
  activeTickPromise = run;
  return run;
}

/**
 * Menunggu tick scheduler yang sedang berjalan hingga selesai (bermanfaat untuk graceful shutdown/test).
 */
async function waitForSchedulerIdle() {
  if (activeTickPromise) {
    await activeTickPromise;
  }
}

/**
 * Mengeksekusi pengiriman digest low stock jika slot jadwal saat ini sudah jatuh tempo.
 * Menggunakan klaim atomik di MongoDB sehingga tahan terhadap restart dan eksekusi paralel.
 */
async function runDigestIfDue({
  now = new Date(),
  send = sendLowStockAlertEmail,
  emailConfigured = isEmailConfigured,
} = {}) {
  const settings = await getLowStockSettings(now);
  if (settings.lastDigestStatus === 'email_not_configured' && emailConfigured()) {
    await NotificationSetting.updateOne(
      { key: SETTINGS_KEY, lastDigestStatus: 'email_not_configured' },
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

  // Klaim slot secara atomik sebelum memanggil provider email
  const claimed = await NotificationSetting.findOneAndUpdate(
    {
      key: SETTINGS_KEY,
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
    return {
      executed: false,
      reason: 'already_claimed',
      occurrence,
    };
  }

  const sameAttemptSlot =
    claimed.lastAttemptOccurrence &&
    new Date(claimed.lastAttemptOccurrence).getTime() === occurrence.getTime();
  const currentAttempt = sameAttemptSlot ? Number(claimed.digestAttempts || 0) + 1 : 1;

  if (!emailConfigured()) {
    await NotificationSetting.updateOne(
      { key: SETTINGS_KEY },
      {
        $set: {
          lastDigestStatus: 'email_not_configured',
          lastDigestCount: 0,
          lastDigestError: 'Konfigurasi email (BREVO_API_KEY atau SMTP_USER/SMTP_PASS) belum diatur',
          digestAttempts: currentAttempt,
          lastAttemptOccurrence: occurrence,
        },
      }
    );
    return {
      executed: true,
      status: 'email_not_configured',
      count: 0,
      attempts: currentAttempt,
      occurrence,
    };
  }

  const products = await Product.find({
    aktif: true,
    $expr: { $lte: ['$stok', '$stokMinimum'] },
  }).sort({ stok: 1 });

  if (products.length === 0) {
    await NotificationSetting.updateOne(
      { key: SETTINGS_KEY },
      {
        $set: {
          lastDigestStatus: 'skipped_empty',
          lastDigestCount: 0,
          lastDigestError: null,
          digestAttempts: currentAttempt,
          lastAttemptOccurrence: occurrence,
        },
      }
    );
    return {
      executed: true,
      status: 'skipped_empty',
      count: 0,
      attempts: currentAttempt,
      occurrence,
    };
  }

  try {
    await send(products, undefined, {
      context: 'digest',
      frequency: claimed.digestFrequency,
    });

    await NotificationSetting.updateOne(
      { key: SETTINGS_KEY },
      {
        $set: {
          lastDigestSentAt: new Date(now),
          lastDigestStatus: 'sent',
          lastDigestCount: products.length,
          lastDigestError: null,
          digestAttempts: currentAttempt,
          lastAttemptOccurrence: occurrence,
        },
      }
    );

    return {
      executed: true,
      status: 'sent',
      count: products.length,
      attempts: currentAttempt,
      occurrence,
    };
  } catch (err) {
    const errorMessage = err && err.message ? String(err.message) : 'Gagal mengirim email digest';
    const shouldRetry = currentAttempt < MAX_DIGEST_ATTEMPTS;

    await NotificationSetting.updateOne(
      { key: SETTINGS_KEY },
      {
        $set: {
          lastDigestOccurrence: shouldRetry
            ? claimed.lastDigestOccurrence || null
            : occurrence,
          lastDigestStatus: 'failed',
          lastDigestCount: products.length,
          lastDigestError: errorMessage,
          digestAttempts: currentAttempt,
          lastAttemptOccurrence: occurrence,
        },
      }
    );

    return {
      executed: true,
      status: shouldRetry ? 'failed_will_retry' : 'failed',
      count: products.length,
      attempts: currentAttempt,
      error: errorMessage,
      occurrence,
    };
  }
}

/**
 * Memulai background interval scheduler untuk mengecek jadwal digest low stock.
 * Langsung menjalankan tick awal saat start untuk catch-up jadwal yang terlewat.
 */
function startLowStockScheduler({ intervalMs, ...runnerOptions } = {}) {
  if (process.env.LOW_STOCK_SCHEDULER_ENABLED === 'false') {
    return null;
  }
  if (schedulerTimer) {
    return schedulerTimer;
  }

  const parsed = Number(intervalMs ?? process.env.LOW_STOCK_SCHEDULER_INTERVAL_MS);
  const effectiveInterval =
    Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_TICK_INTERVAL_MS;

  // Tick pertama saat startup agar jadwal terlewat langsung dikejar (catch-up)
  runSchedulerTick(runnerOptions);

  schedulerTimer = setInterval(() => {
    runSchedulerTick(runnerOptions);
  }, effectiveInterval);

  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }

  console.log(`[LowStockScheduler] Aktif (interval pengecekan ${effectiveInterval} ms)`);
  return schedulerTimer;
}

/**
 * Menghentikan background scheduler.
 */
function stopLowStockScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  MAX_DIGEST_ATTEMPTS,
  DEFAULT_TICK_INTERVAL_MS,
  runDigestIfDue,
  runSchedulerTick,
  waitForSchedulerIdle,
  startLowStockScheduler,
  stopLowStockScheduler,
};
