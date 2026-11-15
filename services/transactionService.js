const mongoose = require('mongoose');
const Product = require('../models/Product');
const Transaction = require('../models/Transaction');
const { transactionRules } = require('../middleware/validate');
const { resetOutOfStockFlags } = require('./lowStockAlertService');

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const validId = (id) => typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);

async function calculateTransactionDetail(detailBarang, session = null) {
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
      jumlah, hargaSatuan: product.hargaJual, subtotal });
  }
  return { detailBarang: detail, totalHarga };
}

async function checkout(detailBarang, kasir) {
  return mongoose.connection.transaction(async (session) => {
    const calculated = await calculateTransactionDetail(detailBarang, session);
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

module.exports = { calculateTransactionDetail, checkout, voidTransaction, historyFilter, validId, fail };
