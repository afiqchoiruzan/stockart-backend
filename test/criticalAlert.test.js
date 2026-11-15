'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = require('../app');
const Product = require('../models/Product');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const NotificationSetting = require('../models/NotificationSetting');
const { triggerCriticalOutOfStockAlerts } = require('../services/lowStockAlertService');

test('Critical Out-of-Stock Alert E2E: checkout stok 0, anti-duplikat, reset restock/void/update, & rollback', async (t) => {
  const dbName = `t_crit_${process.pid}_${Date.now().toString(36)}`;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'stockart_critical_alert_secret';
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });

  let server;
  const prevEnv = {
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    BREVO_API_KEY: process.env.BREVO_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    OWNER_EMAIL: process.env.OWNER_EMAIL,
  };

  t.after(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

  await Promise.all([
    Product.syncIndexes(),
    User.syncIndexes(),
    Transaction.syncIndexes(),
    NotificationSetting.syncIndexes(),
  ]);

  const [owner, kasir] = await User.create([
    { nama: 'Owner Crit', username: `own_crit_${Date.now()}`, password: 'x', role: 'pemilik' },
    { nama: 'Kasir Crit', username: `ksr_crit_${Date.now()}`, password: 'x', role: 'kasir' },
  ]);
  const ownerToken = jwt.sign({ id: owner._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const kasirToken = jwt.sign({ id: kasir._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const realFetch = globalThis.fetch;
  let emailMode = 'ok';
  let sentEmails = [];
  let failedAttempts = 0;

  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const urlStr = String(url);
    if (urlStr.startsWith('https://api.brevo.com/')) {
      const payload = JSON.parse(init.body);
      if (emailMode === 'fail') {
        failedAttempts += 1;
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: async () => JSON.stringify({ message: 'Simulasi Brevo down' }),
        };
      }
      sentEmails.push(payload);
      return { ok: true, status: 201, text: async () => '{"messageId":"m-1"}' };
    }
    return realFetch(url, init);
  });

  async function api(path, { method = 'GET', token = kasirToken, body } = {}) {
    const headers = { Connection: 'close' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await realFetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  async function waitUntil(predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Timeout menunggu kondisi async tercapai (${timeoutMs} ms)`);
  }

  const waitNegativeWindow = () => new Promise((resolve) => setTimeout(resolve, 400));

  delete process.env.NODE_TEST_CONTEXT;
  process.env.BREVO_API_KEY = 'xkeysib-critical-test';
  process.env.EMAIL_FROM = 'noreply@stockart.local';
  process.env.OWNER_EMAIL = 'owner@stockart.local';

  let seq = 0;
  const makeProduct = (nama, stok, stokMinimum = 5) =>
    Product.create({
      nama,
      kodeProduk: `CRT-${++seq}`,
      kategori: 'Sembako',
      hargaBeli: 5000,
      hargaJual: 7000,
      stok,
      stokMinimum,
      aktif: true,
    });

  await t.test('1. Checkout 3 -> 0 mengirim 1 email Kritis dan mengisi stokHabisNotifiedAt', async () => {
    sentEmails = [];
    const p = await makeProduct('Minyak Habis', 3, 5);

    const res = await api('/transactions/checkout', {
      method: 'POST',
      body: { detailBarang: [{ produk: String(p._id), jumlah: 3 }] },
    });
    assert.equal(res.status, 201);
    await waitUntil(() => sentEmails.length === 1);

    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].subject, /^\[StockArt Kritis\] Stok Habis: Minyak Habis/);
    assert.match(sentEmails[0].htmlContent, /transaksi kasir membuat stok produk mencapai 0/);

    const updated = await Product.findById(p._id);
    assert.equal(updated.stok, 0);
    assert.ok(updated.stokHabisNotifiedAt instanceof Date);

    // Panggil ulang trigger langsung untuk produk sama -> tidak mengirim duplikat
    const secondTry = await triggerCriticalOutOfStockAlerts([p._id]);
    assert.equal(secondTry.sent, false);
    assert.equal(sentEmails.length, 1);
  });

  await t.test('2. Checkout 10 -> 4 (masih > 0 walau <= stokMinimum) TIDAK mengirim email kritis', async () => {
    sentEmails = [];
    const p = await makeProduct('Gula Menipis', 10, 5);

    const res = await api('/transactions/checkout', {
      method: 'POST',
      body: { detailBarang: [{ produk: String(p._id), jumlah: 6 }] },
    });
    assert.equal(res.status, 201);
    await waitNegativeWindow();

    assert.equal(sentEmails.length, 0);
    const updated = await Product.findById(p._id);
    assert.equal(updated.stok, 4);
    assert.equal(updated.stokHabisNotifiedAt, null);
  });

  await t.test('3. Restock -> habiskan lagi mengirim email kritis kedua kali', async () => {
    sentEmails = [];
    const p = await makeProduct('Kopi Siklus', 2, 5);

    const tx1 = await api('/transactions/checkout', {
      method: 'POST',
      body: { detailBarang: [{ produk: String(p._id), jumlah: 2 }] },
    });
    assert.equal(tx1.status, 201);
    await waitUntil(() => sentEmails.length === 1);

    const restock = await api(`/products/${p._id}/restock`, {
      method: 'PATCH',
      token: ownerToken,
      body: { jumlah: 4 },
    });
    assert.equal(restock.status, 200);
    assert.equal(restock.json.data.stok, 4);
    assert.equal(restock.json.data.stokHabisNotifiedAt, null);
    await waitNegativeWindow();
    assert.equal(sentEmails.length, 1);

    const tx2 = await api('/transactions/checkout', {
      method: 'POST',
      body: { detailBarang: [{ produk: String(p._id), jumlah: 4 }] },
    });
    assert.equal(tx2.status, 201);
    await waitUntil(() => sentEmails.length === 2);
    assert.equal(sentEmails.length, 2);
  });

  await t.test('4. Void transaksi mengembalikan stok dan me-reset flag habis', async () => {
    sentEmails = [];
    const p = await makeProduct('Teh Void', 2, 5);

    const tx = await api('/transactions/checkout', {
      method: 'POST',
      body: { detailBarang: [{ produk: String(p._id), jumlah: 2 }] },
    });
    assert.equal(tx.status, 201);
    await waitUntil(() => sentEmails.length === 1);

    const voidRes = await api(`/transactions/${tx.json.data._id}/void`, {
      method: 'PATCH',
      token: ownerToken,
    });
    assert.equal(voidRes.status, 200);

    const afterVoid = await Product.findById(p._id);
    assert.equal(afterVoid.stok, 2);
    assert.equal(afterVoid.stokHabisNotifiedAt, null);

    const tx2 = await api('/transactions/checkout', {
      method: 'POST',
      body: { detailBarang: [{ produk: String(p._id), jumlah: 2 }] },
    });
    assert.equal(tx2.status, 201);
    await waitUntil(() => sentEmails.length === 2);
    assert.equal(sentEmails.length, 2);
  });

  await t.test('5. criticalAlertEnabled=false menonaktifkan alert kritis stok 0', async () => {
    sentEmails = [];
    await NotificationSetting.updateOne(
      { key: 'lowStockAlert' },
      { $set: { criticalAlertEnabled: false } },
      { upsert: true }
    );
    try {
      const p = await makeProduct('Mie Nonaktif Alert', 1, 5);
      const tx = await api('/transactions/checkout', {
        method: 'POST',
        body: { detailBarang: [{ produk: String(p._id), jumlah: 1 }] },
      });
      assert.equal(tx.status, 201);
      await waitNegativeWindow();
      assert.equal(sentEmails.length, 0);
      const after = await Product.findById(p._id);
      assert.equal(after.stokHabisNotifiedAt, null);
    } finally {
      await NotificationSetting.updateOne(
        { key: 'lowStockAlert' },
        { $set: { criticalAlertEnabled: true } }
      );
    }
  });

  await t.test('6. 2 checkout paralel menghabiskan produk berbeda -> masing-masing 1 email kritis', async () => {
    sentEmails = [];
    const [a, b] = await Promise.all([
      makeProduct('Paralel A', 1, 3),
      makeProduct('Paralel B', 1, 3),
    ]);

    const [r1, r2] = await Promise.all([
      api('/transactions/checkout', {
        method: 'POST',
        body: { detailBarang: [{ produk: String(a._id), jumlah: 1 }] },
      }),
      api('/transactions/checkout', {
        method: 'POST',
        body: { detailBarang: [{ produk: String(b._id), jumlah: 1 }] },
      }),
    ]);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    await waitUntil(() => sentEmails.length === 2);

    assert.equal(sentEmails.length, 2);
    const combinedHtml = sentEmails.map((e) => e.htmlContent).join('\n');
    assert.match(combinedHtml, /Paralel A/);
    assert.match(combinedHtml, /Paralel B/);
  });

  await t.test('7. 1 keranjang menghabiskan 2 produk sekaligus -> 1 email kritis gabungan', async () => {
    sentEmails = [];
    const [a, b] = await Promise.all([
      makeProduct('Gabung A', 2, 5),
      makeProduct('Gabung B', 3, 5),
    ]);

    const res = await api('/transactions/checkout', {
      method: 'POST',
      body: {
        detailBarang: [
          { produk: String(a._id), jumlah: 2 },
          { produk: String(b._id), jumlah: 3 },
        ],
      },
    });
    assert.equal(res.status, 201);
    await waitUntil(() => sentEmails.length === 1);

    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].subject, /\(\+1 Produk Lainnya\)/);
    assert.match(sentEmails[0].htmlContent, /Gabung A/);
    assert.match(sentEmails[0].htmlContent, /Gabung B/);
  });

  await t.test('8. Email gagal saat checkout -> checkout tetap 201 dan flag stokHabisNotifiedAt di-rollback ke null', async () => {
    sentEmails = [];
    failedAttempts = 0;
    emailMode = 'fail';
    try {
      const p = await makeProduct('Rollback Error', 1, 5);
      const res = await api('/transactions/checkout', {
        method: 'POST',
        body: { detailBarang: [{ produk: String(p._id), jumlah: 1 }] },
      });
      assert.equal(res.status, 201);
      await waitUntil(async () => {
        if (failedAttempts < 1) return false;
        const fresh = await Product.findById(p._id);
        return fresh && fresh.stokHabisNotifiedAt === null;
      });

      assert.equal(sentEmails.length, 0);
      const after = await Product.findById(p._id);
      assert.equal(after.stok, 0);
      assert.equal(after.stokHabisNotifiedAt, null);
    } finally {
      emailMode = 'ok';
    }
  });
});
