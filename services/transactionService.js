const mongoose = require('mongoose');
const Product = require('../models/Product');
const Transaction = require('../models/Transaction');
const { transactionRules } = require('../middleware/validate');
const { resetOutOfStockFlags } = require('./lowStockAlertService');
const paymentService = require('./paymentService');

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const validId = (id) => typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);

// includeCost: sertakan snapshot hargaBeli (hanya untuk disimpan di transaksi, jangan dikirim ke klien)
async function calculateTransactionDetail(detailBarang, session = null, { includeCost = false } = {}) {
  const errors = transactionRules({ detailBarang });
  if (errors.length) throw fail(400, errors.join('; '));
  const quantities = new Map();
  for (const item of detailBarang) {
    const id = item.produk.toLowerCase();
    const quantity = (quantities.get(id) || 0) + Number(item.jumlah);
    if (!Number.isSafeInteger(quantity)) throw fail(400, 'Jumlah produk terlalu besar');
    quantities.set(id, quantity);
  }
  const products = await Product.find({ _id: { $in: [...quantities.keys()] } }).session(session);
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  const detail = [];
  let totalHarga = 0;
  for (const [id, jumlah] of quantities) {
    const product = productMap.get(id);
    if (!product) throw fail(404, `Produk dengan ID ${id} tidak ditemukan`);
    if (!product.aktif) throw fail(409, `Produk ${product.nama} tidak aktif`);
    if (product.stok < jumlah) throw fail(409, `Stok produk ${product.nama} tidak mencukupi`);
    const subtotal = jumlah * product.hargaJual;
    totalHarga += subtotal;
    if (!Number.isFinite(subtotal) || subtotal < 0 || totalHarga > Number.MAX_SAFE_INTEGER) {
      throw fail(400, 'Total harga di luar batas yang didukung');
    }
    detail.push({ produk: product._id, namaProduk: product.nama, kodeProduk: product.kodeProduk,
      jumlah, hargaSatuan: product.hargaJual, subtotal,
      ...(includeCost && Number.isFinite(product.hargaBeli) ? { hargaBeli: product.hargaBeli } : {}) });
  }
  return { detailBarang: detail, totalHarga };
}

async function checkout(detailBarang, kasir) {
  return mongoose.connection.transaction(async (session) => {
    const calculated = await calculateTransactionDetail(detailBarang, session, { includeCost: true });
    // Sequential writes within one session; the predicate also guards concurrent checkout.
    for (const item of calculated.detailBarang) {
      const result = await Product.updateOne(
        { _id: item.produk, aktif: true, stok: { $gte: item.jumlah } },
        { $inc: { stok: -item.jumlah } }, { session }
      );
      if (result.modifiedCount !== 1) throw fail(409, `Stok produk ${item.namaProduk} tidak mencukupi`);
    }
    const [transaction] = await Transaction.create([
      { ...calculated, kasir, status: 'selesai', stokDipotong: true },
    ], { session });
    return transaction;
  });
}

async function voidTransaction(id, userId) {
  if (!validId(id)) throw fail(400, 'ID transaksi tidak valid');
  return mongoose.connection.transaction(async (session) => {
    const transaction = await Transaction.findById(id).session(session);
    if (!transaction) throw fail(404, 'Transaksi tidak ditemukan');
    if (transaction.status === 'batal') throw fail(409, 'Transaksi sudah dibatalkan');
    if (transaction.paymentMethod === 'qris' && transaction.paymentStatus === 'pending') {
      throw fail(409, 'Pembayaran QRIS masih menunggu; transaksi belum dapat dibatalkan');
    }
    if (transaction.stokDipotong) {
      for (const item of transaction.detailBarang) {
        const result = await Product.updateOne({ _id: item.produk },
          { $inc: { stok: item.jumlah } }, { session });
        if (result.matchedCount !== 1) throw fail(409, 'Produk telah dihapus; stok tidak dapat dikembalikan');
      }
      await resetOutOfStockFlags(
        transaction.detailBarang.map((item) => item.produk),
        { session }
      );
    }
    transaction.status = 'batal';
    transaction.dibatalkanPada = new Date();
    transaction.dibatalkanOleh = userId;
    await transaction.save({ session });
    return transaction;
  });
}

/**
 * QRIS langkah 1: simpan transaksi pending lalu minta QR ke Midtrans.
 * Stok hanya dicek (belum dipotong); pemotongan stok dilakukan webhook saat settlement.
 * @returns {Promise<{ transaction: import('mongoose').Document, qrImageUrl: string|null }>}
 */
async function createQrisTransaction(detailBarang, kasir) {
  const calculated = await calculateTransactionDetail(detailBarang, null, { includeCost: true });
  if (!Number.isSafeInteger(calculated.totalHarga) || calculated.totalHarga < 1) {
    throw fail(400, 'Total transaksi QRIS harus bilangan bulat rupiah minimal 1');
  }

  const transaction = await Transaction.create({
    ...calculated, kasir, status: 'selesai', stokDipotong: false,
    paymentMethod: 'qris', paymentStatus: 'pending',
  });

  let qris;
  try {
    qris = await paymentService.createQris(transaction);
  } catch (error) {
    // Simpan jejak percobaan yang gagal; status failed tidak dihitung di laporan.
    await Transaction.updateOne({ _id: transaction._id, paymentStatus: 'pending' },
      { $set: { paymentStatus: 'failed' } }).catch(() => {});
    throw error;
  }

  // Syarat paymentStatus: 'pending' mencegah menimpa status yang sudah diubah webhook.
  const updated = await Transaction.findOneAndUpdate(
    { _id: transaction._id, paymentStatus: 'pending' },
    { $set: { gatewayRef: qris.gatewayRef, qrString: qris.qrString, expiresAt: qris.expiresAt } },
    { returnDocument: 'after' }
  );
  return { transaction: updated || (await Transaction.findById(transaction._id)), qrImageUrl: qris.qrImageUrl };
}

// transaction_status Midtrans (selain settlement) -> paymentStatus. Hanya berlaku dari pending.
const NOTIFICATION_FINAL_STATUS = { expire: 'expired', cancel: 'failed', deny: 'failed', failure: 'failed' };

const insufficientStock = (item, reason) =>
  Object.assign(new Error('Stok tidak mencukupi saat settlement'), { insufficientStock: { item, reason } });

/**
 * QRIS langkah 2 (settlement). Idempoten:
 * - Status diklaim atomik (paymentStatus != paid -> paid) di dalam transaksi DB sebelum stok
 *   disentuh; notifikasi kedua (berurutan atau bersamaan) mendapat 'duplicate' dan tidak memotong stok.
 * - Uang sudah masuk, jadi settlement tetap diproses walau status lokal sudah expired/failed.
 * - Jika stok kurang / produk hilang / transaksi sudah dibatalkan: tetap paid TANPA memotong stok,
 *   dengan paymentNote bahwa uang pelanggan perlu dikembalikan.
 */
async function settleQrisPayment(transactionId, now) {
  const claim = async (session, extra) => Transaction.findOneAndUpdate(
    { _id: transactionId, paymentStatus: { $ne: 'paid' } },
    { $set: { paymentStatus: 'paid', paidAt: now, ...extra } },
    { session, returnDocument: 'after' }
  );

  try {
    return await mongoose.connection.transaction(async (session) => {
      const current = await Transaction.findById(transactionId).session(session);
      if (current.paymentStatus === 'paid') return { result: 'duplicate', transaction: current };
      if (current.status === 'batal') {
        const transaction = await claim(session, {
          paymentNote: 'Pembayaran QRIS diterima setelah transaksi dibatalkan. Uang pelanggan perlu dikembalikan.',
        });
        return { result: transaction ? 'paid_with_note' : 'duplicate', transaction: transaction || current };
      }

      const transaction = await claim(session, { stokDipotong: true });
      if (!transaction) return { result: 'duplicate', transaction: current };
      for (const item of transaction.detailBarang) {
        const res = await Product.updateOne(
          { _id: item.produk, stok: { $gte: item.jumlah } },
          { $inc: { stok: -item.jumlah } }, { session }
        );
        if (res.matchedCount !== 1) {
          const exists = await Product.exists({ _id: item.produk }).session(session);
          throw insufficientStock(item, exists ? 'stok kurang' : 'produk sudah dihapus');
        }
      }
      return { result: 'paid', transaction };
    });
  } catch (error) {
    if (!error.insufficientStock) throw error;
    // Transaksi DB di atas dibatalkan seluruhnya (stok utuh). Tandai paid + catatan tanpa potong stok.
    const { item, reason } = error.insufficientStock;
    return mongoose.connection.transaction(async (session) => {
      const transaction = await claim(session, {
        stokDipotong: false,
        paymentNote: `Pembayaran QRIS diterima tetapi ${reason} untuk ${item.namaProduk} ` +
          `(dibutuhkan ${item.jumlah}). Stok tidak dipotong; uang pelanggan perlu dikembalikan.`,
      });
      if (!transaction) {
        return { result: 'duplicate', transaction: await Transaction.findById(transactionId).session(session) };
      }
      return { result: 'paid_with_note', transaction };
    });
  }
}

/**
 * Proses notifikasi Midtrans yang SIGNATURE-NYA SUDAH DIVERIFIKASI pemanggil.
 * @returns {Promise<{ result: 'paid'|'paid_with_note'|'duplicate'|'expired'|'failed'|'ignored',
 *   transaction: object }>}
 */
async function handleMidtransNotification(notification, now = new Date()) {
  const found = await Transaction.findOne({ gatewayRef: notification.order_id, paymentMethod: 'qris' })
    .select('_id totalHarga paymentStatus');
  if (!found) throw fail(404, 'Transaksi untuk order_id ini tidak ditemukan');

  const grossAmount = Number(notification.gross_amount);
  if (!Number.isFinite(grossAmount) || grossAmount !== found.totalHarga) {
    throw fail(400, `gross_amount ${notification.gross_amount} tidak sama dengan total transaksi ${found.totalHarga}`);
  }

  const status = notification.transaction_status;
  if (status === 'settlement') {
    // transaction_status TIDAK termasuk signature; status_code termasuk. Tanpa cek ini,
    // notifikasi expire (202) asli bisa diubah menjadi "settlement" dan tetap lolos signature.
    if (notification.status_code !== '200') {
      throw fail(400, `status_code ${notification.status_code} tidak sesuai untuk settlement`);
    }
    return settleQrisPayment(found._id, now);
  }

  const target = NOTIFICATION_FINAL_STATUS[status];
  if (target) {
    const transaction = await Transaction.findOneAndUpdate(
      { _id: found._id, paymentStatus: 'pending' },
      { $set: { paymentStatus: target } },
      { returnDocument: 'after' }
    );
    return { result: transaction ? target : 'ignored', transaction: transaction || found };
  }
  // pending, refund, dll.: tidak ada perubahan.
  return { result: 'ignored', transaction: found };
}

const PAYMENT_STATUS_FIELDS =
  'kasir totalHarga status stokDipotong paymentMethod paymentStatus paymentNote expiresAt paidAt';

/**
 * Dipakai frontend untuk polling. Hanya membaca, kecuali menandai pending yang
 * sudah lewat expiresAt menjadi expired. Endpoint ini TIDAK PERNAH mengubah ke paid.
 */
async function getPaymentStatus(id, user, now = new Date()) {
  if (!validId(id)) throw fail(400, 'ID transaksi tidak valid');
  let transaction = await Transaction.findById(id).select(PAYMENT_STATUS_FIELDS);
  if (!transaction) throw fail(404, 'Transaksi tidak ditemukan');
  if (user?.role === 'kasir' && String(transaction.kasir) !== String(user._id)) {
    throw fail(403, 'Anda tidak memiliki akses ke transaksi kasir lain');
  }

  if (transaction.paymentStatus === 'pending' && transaction.expiresAt && transaction.expiresAt <= now) {
    // Atomik: jika webhook sudah mengubah status lebih dulu, update ini tidak berlaku.
    transaction = (await Transaction.findOneAndUpdate(
      { _id: transaction._id, paymentStatus: 'pending', expiresAt: { $lte: now } },
      { $set: { paymentStatus: 'expired' } },
      { returnDocument: 'after', projection: PAYMENT_STATUS_FIELDS }
    )) || (await Transaction.findById(id).select(PAYMENT_STATUS_FIELDS));
  }

  return {
    _id: transaction._id,
    totalHarga: transaction.totalHarga,
    status: transaction.status,
    paymentMethod: transaction.paymentMethod,
    paymentStatus: transaction.paymentStatus,
    stokDipotong: transaction.stokDipotong,
    // Jika terisi saat paid: uang masuk tapi transaksi bermasalah -> frontend tampilkan peringatan.
    paymentNote: transaction.paymentNote || null,
    expiresAt: transaction.expiresAt || null,
    paidAt: transaction.paidAt || null,
  };
}

function historyFilter(query) {
  const filter = {};
  if (query.kasir !== undefined) {
    if (!validId(query.kasir)) throw fail(400, 'ID kasir tidak valid');
    filter.kasir = query.kasir;
  }
  if (query.tanggal !== undefined) {
    const date = query.tanggal;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw fail(400, 'Tanggal harus valid dengan format YYYY-MM-DD');
    }
    const start = new Date(`${date}T00:00:00+07:00`);
    filter.createdAt = { $gte: start, $lt: new Date(start.getTime() + 86400000) };
  }
  if (query.status !== undefined) {
    if (!['selesai', 'batal'].includes(query.status)) throw fail(400, 'Status transaksi tidak valid');
    filter.status = query.status;
  }
  return filter;
}

module.exports = { calculateTransactionDetail, checkout, voidTransaction, historyFilter, validId, fail,
  createQrisTransaction, getPaymentStatus, handleMidtransNotification };
