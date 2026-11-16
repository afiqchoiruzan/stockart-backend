'use strict';

const StockEntry = require('../models/StockEntry');

/**
 * Mencatat riwayat barang masuk untuk laporan "Produk Masuk".
 * Kegagalan pencatatan tidak membatalkan perubahan stok yang sudah tersimpan,
 * cukup dicatat di log server.
 */
async function recordStockEntry({ product, jumlah, sumber, userId }) {
  const qty = Number(jumlah);
  if (!product || !Number.isFinite(qty) || qty < 1) {
    return null;
  }

  try {
    return await StockEntry.create({
      produk: product._id,
      namaProduk: product.nama,
      kodeProduk: product.kodeProduk,
      jumlah: qty,
      sumber,
      dicatatOleh: userId,
    });
  } catch (err) {
    console.error('[StockEntry] Gagal mencatat barang masuk:', err.message);
    return null;
  }
}

module.exports = { recordStockEntry };
