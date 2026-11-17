const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const app = require('../app');
const Product = require('../models/Product');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { transactionRules } = require('../middleware/validate');
const { historyFilter } = require('../services/transactionService');

const objectId = () => new mongoose.Types.ObjectId().toString();

test('validasi keranjang menolak input rusak dan jumlah tidak aman', () => {
  for (const item of [null, [], 1, {}, { produk: 'invalid', jumlah: 1 },
    { produk: objectId(), jumlah: true }, { produk: objectId(), jumlah: [] },
    { produk: objectId(), jumlah: 0 }, { produk: objectId(), jumlah: 1.5 },
    { produk: objectId(), jumlah: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.ok(transactionRules({ detailBarang: [item] }).length);
  }
  assert.deepEqual(transactionRules({ detailBarang: [{ produk: objectId(), jumlah: '2' }] }), []);
});

test('filter harian menggunakan WIB dan menolak tanggal/ID/status tidak valid', () => {
  const filter = historyFilter({ tanggal: '2026-09-29' });
  assert.equal(filter.createdAt.$gte.toISOString(), '2026-09-28T17:00:00.000Z');
  assert.equal(filter.createdAt.$lt.toISOString(), '2026-09-29T17:00:00.000Z');
  for (const query of [{ tanggal: '2026-02-30' }, { tanggal: 'no' }, { tanggal: [] },
    { kasir: 'wrong' }, { status: 'draft' }]) {
    assert.throws(() => historyFilter(query), { statusCode: 400 });
  }
});

test('alur HTTP transaksi dengan MongoDB replica set', async (t) => {
  // Nama database ringkas (< 38 byte batas MongoDB Atlas M0) agar tetap terisolasi dan tidak gagal di CI.
  const dbName = `t_tx_${process.pid}_${Date.now().toString(36)}`;
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
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
  await Promise.all([Product.init(), Transaction.init(), User.init()]);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(method, path, body, token) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  }
  const password = await bcrypt.hash('TestPassword123', 4);
  const [kasir, owner] = await User.create([
    { nama: 'Kasir', username: 'transaction_kasir', password, role: 'kasir' },
    { nama: 'Owner', username: 'transaction_owner', password, role: 'pemilik' },
  ]);
  async function login(user) {
    const response = await request('POST', '/auth/login', { username: user.username, password: 'TestPassword123' });
    assert.equal(response.status, 200);
    return response.data.token;
  }
  const token = await login(kasir);
  const ownerToken = await login(owner);
  let seq = 0;
  async function product(stok = 10, extra = {}) {
    return Product.create({ nama: 'Produk uji', kodeProduk: `TEST-${++seq}`, hargaBeli: 500,
      hargaJual: 1000, stok, ...extra });
  }
  const cart = (p, jumlah = 1) => ({ detailBarang: [{ produk: String(p._id), jumlah }] });
  const stock = async (p) => (await Product.findById(p._id)).stok;
  const checkout = (body) => request('POST', '/transactions/checkout', body, token);
  const voidTx = (id) => request('PATCH', `/transactions/${id}/void`, undefined, ownerToken);

  await t.test('login -> draf -> checkout -> void mempertahankan snapshot dan audit', async () => {
    const p = await product();
    const body = { detailBarang: [{ produk: String(p._id), jumlah: 2 },
      { produk: String(p._id).toUpperCase(), jumlah: 1 }] };
    const draft = await request('POST', '/transactions/draft', body, token);
    assert.equal(draft.status, 200);
    assert.equal(draft.data.totalHarga, 3000);
    assert.equal(draft.data.detailBarang.length, 1);
    assert.equal(await stock(p), 10);
    assert.equal(await Transaction.countDocuments(), 0);
    await Product.updateOne({ _id: p._id }, { hargaJual: 1200 });
    const done = await checkout({ ...body, totalHarga: 1, kasir: owner._id, status: 'batal' });
    assert.equal(done.status, 201);
    assert.equal(done.data.totalHarga, 3600);
    assert.equal(done.data.kasir, String(kasir._id));
    assert.equal(done.data.status, 'selesai');
    assert.equal(done.data.detailBarang[0].namaProduk, p.nama);
    assert.equal(await stock(p), 7);
    assert.equal((await request('PATCH', `/transactions/${done.data._id}/void`, undefined, token)).status, 403);
    await Product.updateOne({ _id: p._id }, { hargaJual: 9999, nama: 'Nama baru' });
    const cancelled = await voidTx(done.data._id);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.status, 'batal');
    assert.equal(cancelled.data.dibatalkanOleh, String(owner._id));
    assert.ok(cancelled.data.dibatalkanPada);
    assert.equal(cancelled.data.detailBarang[0].hargaSatuan, 1200);
    assert.equal(await stock(p), 10);
    assert.equal((await voidTx(done.data._id)).status, 409);
    assert.equal(await stock(p), 10);
    assert.ok(await Transaction.findById(done.data._id));
    const report = await request('GET', '/reports/summary', undefined, ownerToken);
    assert.equal(report.data.totalOmzet, 0);
  });

  await t.test('stok kurang, produk nonaktif/hilang, dan body rusak ditolak', async () => {
    const p = await product(1);
    assert.equal((await checkout(cart(p, 2))).status, 409);
    assert.equal((await checkout({ detailBarang: [cart(p).detailBarang[0], cart(p).detailBarang[0]] })).status, 409);
    assert.equal((await checkout(cart(await product(10, { aktif: false })))).status, 409);
    assert.equal((await checkout(cart({ _id: objectId() }))).status, 404);
    assert.equal((await checkout({ detailBarang: [null] })).status, 400);
    assert.equal((await checkout({ detailBarang: [{ produk: 'bad', jumlah: 1 }] })).status, 400);
    assert.equal((await request('POST', '/transactions/checkout', cart(p))).status, 401);
    assert.equal(await stock(p), 1);
  });

  await t.test('checkout bersamaan tidak membuat stok negatif', async () => {
    const p = await product(1);
    const responses = await Promise.all([checkout(cart(p)), checkout(cart(p))]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await stock(p), 0);
    assert.equal(await Transaction.countDocuments({ 'detailBarang.produk': p._id }), 1);
  });

  await t.test('kegagalan penyimpanan transaksi me-rollback semua pemotongan stok', async () => {
    const a = await product(), b = await product();
    const mock = t.mock.method(Transaction, 'create', async () => { throw new Error('Simulasi DB gagal'); });
    try {
      const response = await checkout({ detailBarang: [...cart(a, 2).detailBarang, ...cart(b, 3).detailBarang] });
      assert.equal(response.status, 500);
      assert.equal(await stock(a), 10);
      assert.equal(await stock(b), 10);
      assert.equal(await Transaction.countDocuments({ 'detailBarang.produk': a._id }), 0);
    } finally { mock.mock.restore(); }
  });

  await t.test('void bersamaan hanya mengembalikan stok sekali', async () => {
    const p = await product();
    const done = await checkout(cart(p, 3));
    const responses = await Promise.all([voidTx(done.data._id), voidTx(done.data._id)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await stock(p), 10);
  });

  await t.test('void produk terhapus me-rollback restock parsial dan status', async () => {
    const a = await product(), b = await product();
    const done = await checkout({ detailBarang: [...cart(a, 2).detailBarang, ...cart(b, 3).detailBarang] });
    await Product.deleteOne({ _id: b._id });
    assert.equal((await voidTx(done.data._id)).status, 409);
    assert.equal(await stock(a), 8);
    assert.equal((await Transaction.findById(done.data._id)).status, 'selesai');
  });

  await t.test('void transaksi lama tidak menambah stok yang belum dipotong', async () => {
    const p = await product();
    const old = await Transaction.create({ kasir: kasir._id, totalHarga: 1000,
      detailBarang: [{ produk: p._id, jumlah: 1, hargaSatuan: 1000, subtotal: 1000 }] });
    // Simulate actual old documents where the field is absent.
    await Transaction.collection.updateOne({ _id: old._id }, { $unset: { stokDipotong: '' } });
    assert.equal((await voidTx(old._id)).status, 200);
    assert.equal(await stock(p), 10);
  });

  await t.test('filter tanggal dan kasir mencakup tepat satu hari WIB', async () => {
    const p = await product();
    const ids = [];
    for (const date of ['2026-09-28T16:59:59.999Z', '2026-09-28T17:00:00.000Z',
      '2026-09-29T16:59:59.999Z', '2026-09-29T17:00:00.000Z']) {
      const tx = await Transaction.create({ kasir: owner._id, totalHarga: 1000, createdAt: new Date(date),
        detailBarang: [{ produk: p._id, jumlah: 1, hargaSatuan: 1000, subtotal: 1000 }] });
      ids.push(String(tx._id));
    }
    // Pemilik dapat memfilter riwayat transaksi lintas kasir & tanggal (kasir dikunci ke hari ini WIB)
    const response = await request('GET', `/transactions?tanggal=2026-09-29&kasir=${owner._id}&status=selesai`, undefined, ownerToken);
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.map((tx) => tx._id), [ids[2], ids[1]]);
    assert.equal((await request('GET', '/transactions?tanggal=2026-02-30', undefined, ownerToken)).status, 400);

    // Kasir tidak bisa melihat transaksi tanggal lampau meski mengirim query ?tanggal=
    await Transaction.create({ kasir: kasir._id, totalHarga: 1000, createdAt: new Date('2026-09-29T05:00:00.000Z'),
      detailBarang: [{ produk: p._id, jumlah: 1, hargaSatuan: 1000, subtotal: 1000 }] });
    const kasirPastRes = await request('GET', '/transactions?tanggal=2026-09-29', undefined, token);
    assert.equal(kasirPastRes.status, 200);
    assert.equal(kasirPastRes.data.some((tx) => String(tx.createdAt).startsWith('2026-09-29')), false);

    assert.equal((await request('GET', '/transactions/bad', undefined, token)).status, 400);
    assert.equal((await voidTx(objectId())).status, 404);
  });
});
