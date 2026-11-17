'use strict';

const Product = require('../models/Product');
const { isEmailConfigured, sendLowStockAlertEmail } = require('./emailService');
const { getLowStockSettings } = require('./lowStockSettingsService');

/**
 * Mengirim alert kritis sekali saja ketika transaksi membuat stok produk aktif menjadi <= 0.
 * Menggunakan klaim atomik per produk via `stokHabisNotifiedAt` dan me-rollback flag jika pengiriman gagal.
 */
async function triggerCriticalOutOfStockAlerts(
  productIds,
  { send = sendLowStockAlertEmail, emailConfigured = isEmailConfigured } = {}
) {
  if (!emailConfigured()) {
    return { sent: false, reason: 'email_not_configured', count: 0 };
  }

  if (!Array.isArray(productIds) || productIds.length === 0) {
    return { sent: false, reason: 'no_products', count: 0 };
  }

  const settings = await getLowStockSettings();
  if (!settings.criticalAlertEnabled) {
    return { sent: false, reason: 'disabled', count: 0 };
  }

  const uniqueIds = [...new Set(productIds.map((id) => String(id)).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { sent: false, reason: 'no_products', count: 0 };
  }

  const now = new Date();
  const claimedResults = await Promise.all(
    uniqueIds.map((id) =>
      Product.findOneAndUpdate(
        {
          _id: id,
          aktif: true,
          stok: { $lte: 0 },
          stokHabisNotifiedAt: null,
        },
        { $set: { stokHabisNotifiedAt: now } },
        { returnDocument: 'after' }
      )
    )
  );

  const claimedProducts = claimedResults.filter(Boolean);
  if (claimedProducts.length === 0) {
    return { sent: false, reason: 'none_critical', count: 0 };
  }

  try {
    await send(claimedProducts, settings.recipientEmail || undefined, {
      context: 'critical',
    });
    return {
      sent: true,
      count: claimedProducts.length,
      products: claimedProducts,
    };
  } catch (err) {
    // Kembalikan flag hanya untuk klaim dengan timestamp `now` milik eksekusi ini
    await Product.updateMany(
      {
        _id: { $in: claimedProducts.map((p) => p._id) },
        stokHabisNotifiedAt: now,
      },
      { $set: { stokHabisNotifiedAt: null } }
    ).catch(() => {});
    throw err;
  }
}

/**
 * Mereset flag `stokHabisNotifiedAt` pada produk yang stoknya sudah kembali > 0
 * (setelah restock, pembaruan produk, atau pembatalan/void transaksi).
 */
async function resetOutOfStockFlags(productIds, { session = null } = {}) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return { modifiedCount: 0 };
  }

  const uniqueIds = [...new Set(productIds.map((id) => String(id)).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { modifiedCount: 0 };
  }

  const opts = session ? { session } : undefined;
  return Product.updateMany(
    {
      _id: { $in: uniqueIds },
      stok: { $gt: 0 },
      stokHabisNotifiedAt: { $ne: null },
    },
    { $set: { stokHabisNotifiedAt: null } },
    opts
  );
}

module.exports = {
  triggerCriticalOutOfStockAlerts,
  resetOutOfStockFlags,
};
