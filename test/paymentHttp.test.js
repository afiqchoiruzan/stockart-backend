// Uji HTTP endpoint QRIS dengan MongoDB replica set (database sementara, dihapus setelah tes).
// Midtrans dipalsukan di level fetch, jadi tes tidak butuh server key asli dan tidak memanggil internet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config({ quiet: true });
const app = require('../app');
const Product = require('../models/Product');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

test('alur HTTP pembayaran QRIS (buat QR, status, expired)', async (t) => {
  const dbName = `t_pay_${process.pid}_${Date.now().toString(36)}`;
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });

  const realFetch = globalThis.fetch;
  const savedKey = process.env.MIDTRANS_SERVER_KEY;
  const savedUrl = process.env.MIDTRANS_BASE_URL;
  const savedSigKey = process.env.MIDTRANS_SIGNATURE_KEY;
  process.env.MIDTRANS_SERVER_KEY = 'SB-Mid-server-dummy-test';
  delete process.env.MIDTRANS_SIGNATURE_KEY; // signature tes dihitung dengan server key dummy
  process.env.MIDTRANS_BASE_URL = 'https://api.sandbox.midtrans.com';

  // Midtrans palsu: request ke sandbox dicegat, request lain (ke server tes) diteruskan.
  const midtransCalls = [];
  let midtransReply = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.sandbox.midtrans.com')) {
      const body = JSON.parse(init.body);
      midtransCalls.push(body);
      const { status, json } = midtransReply(body);
      return { ok: status < 300, status, text: async () => JSON.stringify(json) };
    }
    return realFetch(url, init);
  };
  const midtransOk = (body) => ({ status: 200, json: {
    status_code: '201', transaction_id: `mid-${midtransCalls.length}`,
    order_id: body.transaction_details.order_id,
    gross_amount: `${body.transaction_details.gross_amount}.00`,
    transaction_time: '2026-11-16 10:00:00', transaction_status: 'pending',
    qr_string: `QR-${body.transaction_details.order_id}`, expiry_time: '2099-01-01 10:15:00',
    actions: [{ name: 'generate-qr-code', method: 'GET',
      url: `https://api.sandbox.midtrans.com/v2/qris/mid-${midtransCalls.length}/qr-code` }],
  } });
  midtransReply = midtransOk;

  let server;
  t.after(async () => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.MIDTRANS_SERVER_KEY;
    else process.env.MIDTRANS_SERVER_KEY = savedKey;
    if (savedUrl === undefined) delete process.env.MIDTRANS_BASE_URL;
    else process.env.MIDTRANS_BASE_URL = savedUrl;
    if (savedSigKey !== undefined) process.env.MIDTRANS_SIGNATURE_KEY = savedSigKey;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    } finally {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
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
  const [kasir, kasirLain, owner] = await User.create([
    { nama: 'Kasir', username: 'pay_kasir', password, role: 'kasir' },
    { nama: 'Kasir Lain', username: 'pay_kasir2', password, role: 'kasir' },
    { nama: 'Owner', username: 'pay_owner', password, role: 'pemilik' },
  ]);
  async function login(user) {
    const response = await request('POST', '/auth/login', { username: user.username, password: 'TestPassword123' });
    assert.equal(response.status, 200);
    return response.data.token;
  }
  const token = await login(kasir);
  const tokenLain = await login(kasirLain);
  const ownerToken = await login(owner);

  let seq = 0;
  const product = (stok = 10, extra = {}) => Product.create({ nama: 'Produk QRIS', kodeProduk: `PAY-${++seq}`,
    hargaBeli: 500, hargaJual: 2500, stok, ...extra });
  const cart = (p, jumlah = 1) => ({ detailBarang: [{ produk: String(p._id), jumlah }] });
  const stock = async (p) => (await Product.findById(p._id)).stok;
  const createQris = (body, tk = token) => request('POST', '/payments/qris', body, tk);
  const status = (id, tk = token) => request('GET', `/transactions/${id}/status`, undefined, tk);

  await t.test('tanpa token ditolak 401', async () => {
    const p = await product();
    assert.equal((await createQris(cart(p), null)).status, 401);
    assert.equal((await status(new mongoose.Types.ObjectId().toString(), null)).status, 401);
    assert.equal(midtransCalls.length, 0);
  });

  let pendingId;
  await t.test('POST /payments/qris membuat transaksi pending + QR, stok belum dipotong', async () => {
    const p = await product(10);
    const res = await createQris({ ...cart(p, 2), totalHarga: 1, paymentStatus: 'paid' });
    assert.equal(res.status, 201);
    const d = res.data;
    pendingId = d._id;
    assert.equal(d.totalHarga, 5000); // dihitung ulang di server, field kiriman klien diabaikan
    assert.equal(d.paymentMethod, 'qris');
    assert.equal(d.paymentStatus, 'pending');
    assert.equal(d.stokDipotong, false);
    assert.equal(d.kasir, String(kasir._id));
    assert.match(d.gatewayRef, new RegExp(`^${d._id}-`));
    assert.equal(d.qrString, `QR-${d.gatewayRef}`);
    assert.ok(d.expiresAt);
    assert.match(d.qrImageUrl, /\/v2\/qris\/.+\/qr-code$/);
    assert.equal(midtransCalls.at(-1).transaction_details.gross_amount, 5000);
    assert.equal(await stock(p), 10);

    const saved = await Transaction.findById(d._id);
    assert.equal(saved.qrString, d.qrString);
    assert.equal(saved.gatewayRef, d.gatewayRef);
  });

  await t.test('GET status = pending; kasir lain 403; owner boleh', async () => {
    const res = await status(pendingId);
    assert.equal(res.status, 200);
    assert.equal(res.data.paymentStatus, 'pending');
    assert.equal(res.data.paymentMethod, 'qris');
    assert.equal(res.data.paidAt, null);
    assert.equal(res.data.qrString, undefined); // respons status ringan
    assert.equal((await status(pendingId, tokenLain)).status, 403);
    assert.equal((await status(pendingId, ownerToken)).data.paymentStatus, 'pending');
    assert.equal((await status('bukan-id')).status, 400);
    assert.equal((await status(new mongoose.Types.ObjectId().toString())).status, 404);
  });

  await t.test('pending yang lewat expiresAt terbaca dan tersimpan sebagai expired', async () => {
    await Transaction.updateOne({ _id: pendingId }, { expiresAt: new Date(Date.now() - 1000) });
    const res = await status(pendingId);
    assert.equal(res.data.paymentStatus, 'expired');
    assert.equal((await Transaction.findById(pendingId)).paymentStatus, 'expired');
    assert.equal((await status(pendingId)).data.paymentStatus, 'expired');
  });

  await t.test('stok kurang / produk nonaktif / body rusak ditolak tanpa memanggil Midtrans', async () => {
    const before = midtransCalls.length;
    const p = await product(1);
    assert.equal((await createQris(cart(p, 2))).status, 409);
    assert.equal((await createQris(cart(await product(5, { aktif: false })))).status, 409);
    assert.equal((await createQris({ detailBarang: [] })).status, 400);
    assert.equal((await createQris(cart(await product(5, { hargaJual: 1500.5 })))).status, 400);
    assert.equal(midtransCalls.length, before);
  });

  await t.test('Midtrans menolak -> 502 terkontrol, transaksi ditandai failed, stok utuh', async () => {
    const p = await product(4);
    midtransReply = () => ({ status: 401, json: { error: 'Unauthorized' } });
    const res = await createQris(cart(p));
    midtransReply = midtransOk;
    assert.equal(res.status, 502);
    assert.equal(res.success, false);
    assert.match(res.message, /Server key Midtrans tidak valid/);
    const failed = await Transaction.findOne({ 'detailBarang.produk': p._id });
    assert.equal(failed.paymentStatus, 'failed');
    assert.equal(failed.qrString, undefined);
    assert.equal(await stock(p), 4);
  });

  await t.test('server key kosong -> 500 dengan pesan umum (detail tidak bocor)', async () => {
    delete process.env.MIDTRANS_SERVER_KEY;
    const res = await createQris(cart(await product()));
    process.env.MIDTRANS_SERVER_KEY = 'SB-Mid-server-dummy-test';
    assert.equal(res.status, 500);
    assert.equal(res.message, 'Gagal memproses pembayaran');
  });

  await t.test('checkout tunai tetap seperti semula (cash + paid, stok dipotong)', async () => {
    const p = await product(3);
    const res = await request('POST', '/transactions/checkout', cart(p), token);
    assert.equal(res.status, 201);
    assert.equal(res.data.paymentMethod, 'cash');
    assert.equal(res.data.paymentStatus, 'paid');
    assert.equal(await stock(p), 2);
    assert.equal((await status(res.data._id)).data.paymentStatus, 'paid');
  });

  await t.test('laporan hanya menghitung yang lunas (QRIS pending/expired/failed tidak masuk omzet)', async () => {
    const p = await product();
    await createQris(cart(p)); // satu lagi QRIS pending
    const report = await request('GET', '/reports/summary', undefined, ownerToken);
    assert.equal(report.status, 200);
    assert.equal(report.data.totalOmzet, 2500); // hanya checkout tunai di atas
  });

  // ─── Webhook ────────────────────────────────────────────────────────────────
  const { computeNotificationSignature } = require('../services/paymentService');
  const STATUS_CODE = { settlement: '200', pending: '201', expire: '202', deny: '202', cancel: '202' };
  function notif(trx, transaction_status, overrides = {}) {
    const n = { order_id: trx.gatewayRef, status_code: STATUS_CODE[transaction_status],
      gross_amount: `${trx.totalHarga}.00`, transaction_status, payment_type: 'qris',
      fraud_status: 'accept', ...overrides };
    n.signature_key = computeNotificationSignature(n, process.env.MIDTRANS_SERVER_KEY);
    return n;
  }
  const webhook = (body) => request('POST', '/payments/webhook', body); // tanpa token
  const newQris = async (stok = 10, jumlah = 2) => {
    const p = await product(stok);
    const res = await createQris(cart(p, jumlah));
    assert.equal(res.status, 201);
    return { p, trx: res.data };
  };

  await t.test('webhook: signature palsu / hilang ditolak 401 tanpa mengubah apa pun', async () => {
    const { p, trx } = await newQris();
    const forged = { ...notif(trx, 'settlement'), signature_key: 'a'.repeat(128) };
    assert.equal((await webhook(forged)).status, 401);
    // payload diubah setelah ditandatangani
    assert.equal((await webhook({ ...notif(trx, 'settlement'), gross_amount: '1.00' })).status, 401);
    assert.equal((await webhook({ ...notif(trx, 'settlement'), status_code: '202' })).status, 401);
    // transaction_status tidak ikut signature: expire (202) asli yang diubah jadi settlement ditolak
    const tampered = await webhook({ ...notif(trx, 'expire'), transaction_status: 'settlement' });
    assert.equal(tampered.status, 400);
    assert.match(tampered.message, /status_code 202 tidak sesuai/);
    const { signature_key, ...unsigned } = notif(trx, 'settlement');
    assert.equal((await webhook(unsigned)).status, 401);
    assert.equal((await webhook({})).status, 401);
    // signature dari server key lain
    const otherKey = { ...notif(trx, 'settlement') };
    otherKey.signature_key = computeNotificationSignature(otherKey, 'SB-Mid-server-kunci-lain');
    assert.equal((await webhook(otherKey)).status, 401);
    const saved = await Transaction.findById(trx._id);
    assert.equal(saved.paymentStatus, 'pending');
    assert.equal(await stock(p), 10);
  });

  await t.test('webhook: settlement valid -> paid, paidAt terisi, stok berkurang tepat satu kali', async () => {
    const { p, trx } = await newQris(10, 2);
    assert.equal((await webhook(notif(trx, 'pending'))).data.result, 'ignored');
    const res = await webhook(notif(trx, 'settlement'));
    assert.equal(res.status, 200);
    assert.equal(res.data.result, 'paid');
    assert.equal(await stock(p), 8);
    const saved = await Transaction.findById(trx._id);
    assert.equal(saved.paymentStatus, 'paid');
    assert.ok(saved.paidAt);
    assert.equal(saved.stokDipotong, true);
    assert.equal(saved.paymentNote, undefined);
    const st = await status(trx._id);
    assert.equal(st.data.paymentStatus, 'paid');
    assert.equal(st.data.paymentNote, null);

    // dikirim ulang dua kali lagi -> 200 duplicate, stok tetap
    for (let i = 0; i < 2; i++) {
      const again = await webhook(notif(trx, 'settlement'));
      assert.equal(again.status, 200);
      assert.equal(again.data.result, 'duplicate');
    }
    assert.equal(await stock(p), 8);
    // expire yang datang terlambat tidak menurunkan status paid
    assert.equal((await webhook(notif(trx, 'expire'))).data.result, 'ignored');
    assert.equal((await Transaction.findById(trx._id)).paymentStatus, 'paid');
  });

  await t.test('webhook: dua settlement bersamaan tetap memotong stok satu kali', async () => {
    const { p, trx } = await newQris(10, 3);
    const results = await Promise.all([webhook(notif(trx, 'settlement')), webhook(notif(trx, 'settlement'))]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(results.map((r) => r.data.result).sort(), ['duplicate', 'paid']);
    assert.equal(await stock(p), 7);
  });

  await t.test('webhook: expire -> expired, deny/cancel -> failed', async () => {
    const a = await newQris();
    assert.equal((await webhook(notif(a.trx, 'expire'))).data.result, 'expired');
    assert.equal((await status(a.trx._id)).data.paymentStatus, 'expired');
    const b = await newQris();
    assert.equal((await webhook(notif(b.trx, 'deny'))).data.result, 'failed');
    const c = await newQris();
    assert.equal((await webhook(notif(c.trx, 'cancel'))).data.result, 'failed');
    assert.equal(await stock(a.p), 10);
  });

  await t.test('webhook: settlement terlambat setelah expired tetap paid dan memotong stok', async () => {
    const { p, trx } = await newQris(10, 1);
    await Transaction.updateOne({ _id: trx._id }, { expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await status(trx._id)).data.paymentStatus, 'expired'); // ditandai oleh polling
    assert.equal((await webhook(notif(trx, 'settlement'))).data.result, 'paid');
    assert.equal(await stock(p), 9);
  });

  await t.test('webhook: stok kurang saat settlement -> paid + catatan, stok tidak dipotong', async () => {
    const { p, trx } = await newQris(5, 4);
    await Product.updateOne({ _id: p._id }, { stok: 2 }); // terjual di kasir lain selama QR menunggu
    const res = await webhook(notif(trx, 'settlement'));
    assert.equal(res.status, 200);
    assert.equal(res.data.result, 'paid_with_note');
    assert.equal(await stock(p), 2);
    const st = (await status(trx._id)).data;
    assert.equal(st.paymentStatus, 'paid');
    assert.equal(st.stokDipotong, false);
    assert.match(st.paymentNote, /stok kurang untuk Produk QRIS \(dibutuhkan 4\).*dikembalikan/);
    assert.equal((await webhook(notif(trx, 'settlement'))).data.result, 'duplicate');
    // pemilik membatalkan setelah refund: stok tidak "dikembalikan" karena memang tidak pernah dipotong
    const voided = await request('PATCH', `/transactions/${trx._id}/void`, undefined, ownerToken);
    assert.equal(voided.status, 200);
    assert.equal(await stock(p), 2);
  });

  await t.test('void: ditolak selama QRIS pending; setelah paid boleh dan stok kembali', async () => {
    const { p, trx } = await newQris(10, 2);
    const blocked = await request('PATCH', `/transactions/${trx._id}/void`, undefined, ownerToken);
    assert.equal(blocked.status, 409);
    assert.match(blocked.message, /masih menunggu/);
    await webhook(notif(trx, 'settlement'));
    assert.equal(await stock(p), 8);
    assert.equal((await request('PATCH', `/transactions/${trx._id}/void`, undefined, ownerToken)).status, 200);
    assert.equal(await stock(p), 10);
  });

  await t.test('webhook: order_id tidak dikenal 404, gross_amount berbeda 400', async () => {
    const { p, trx } = await newQris();
    assert.equal((await webhook(notif({ gatewayRef: 'tidak-ada-123', totalHarga: 5000 }, 'settlement'))).status, 404);
    const res = await webhook(notif(trx, 'settlement', { gross_amount: '1.00' }));
    assert.equal(res.status, 400);
    assert.equal((await Transaction.findById(trx._id)).paymentStatus, 'pending');
    assert.equal(await stock(p), 10);
  });
});
