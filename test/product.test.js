const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const Product = require('../models/Product');
const User = require('../models/User');
const app = require('../app');
const { productRules } = require('../middleware/validate');

const payload = { nama: 'Produk otomatis', hargaBeli: 1000, hargaJual: 2000, stok: 10 };

test('kode otomatis berbeda pada setiap produk dan kode manual tetap dipertahankan', async () => {
  assert.deepEqual(productRules(payload), []);
  const products = Array.from({ length: 100 }, () => new Product(payload));
  await Promise.all(products.map((product) => product.validate()));
  assert.equal(new Set(products.map((product) => product.kodeProduk)).size, 100);
  assert.match(products[0].kodeProduk, /^PRD-[0-9A-F-]{36}$/);
  const manual = new Product({ ...payload, kodeProduk: ' atk-test-001 ' });
  await manual.validate();
  assert.equal(manual.kodeProduk, 'ATK-TEST-001');
  for (const kodeProduk of ['', '   ', null, 123, {}, []]) {
    assert.ok(productRules({ ...payload, kodeProduk }).length);
  }
});

test('HTTP: request berulang dan bersamaan menghasilkan kode unik yang tersimpan', async (t) => {
  const dbName = `prd_test_${process.pid}_${Date.now()}`;
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  });
  await Promise.all([Product.init(), User.init()]);
  const owner = await User.create({ nama: 'Owner test', username: 'product_test_owner',
    password: 'test-only', role: 'pemilik' });
  const token = jwt.sign({ id: owner._id }, process.env.JWT_SECRET, { expiresIn: '5m' });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/products`;
  async function request(method, path, body) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  }
  const first = await request('POST', '', payload);
  assert.equal(first.status, 201, JSON.stringify(first));
  const results = await Promise.all(Array.from({ length: 5 }, () => request('POST', '', payload)));
  for (const result of results) assert.equal(result.status, 201, JSON.stringify(result));
  const products = [first, ...results].map((result) => result.data);
  assert.equal(new Set(products.map((product) => product.kodeProduk)).size, 6);
  assert.equal(new Set(products.map((product) => product._id)).size, 6);
  assert.equal(await Product.countDocuments(), 6);
  const updated = await request('PUT', `/${first.data._id}`, { nama: 'Nama baru' });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.kodeProduk, first.data.kodeProduk);
  const barcode = await request('GET', `?barcode=${first.data.kodeProduk}`);
  assert.equal(barcode.data[0]._id, first.data._id);
  const manual = { ...payload, kodeProduk: 'ATK-TEST-001' };
  assert.equal((await request('POST', '', manual)).status, 201);
  assert.equal((await request('POST', '', manual)).status, 400);
  assert.equal(await Product.countDocuments({ kodeProduk: manual.kodeProduk }), 1);
});


test('E2E Logika Product Lengkap (CRUD, Filter, Restock, Soft/Hard Delete, Restore, Low-Stock Alert, & RBAC)', async (t) => {
  require('dotenv').config({ quiet: true });
  const testLib = require('node:test');
  const strictAssert = require('node:assert/strict');
  const httpLib = require('node:http');
  const tls = require('node:tls');
  const { EventEmitter } = require('node:events');
  const mongooseLib = require('mongoose');
  const jwt = require('jsonwebtoken');
  const expressApp = require('../app');
  const ProductModel = require('../models/Product');
  const UserModel = require('../models/User');

  void testLib;

  const baseUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/stockart_test';
  const dbName = `prd_e2e_${process.pid}_${Date.now()}`;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'stockart_product_e2e_jwt_secret';

  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      if (mongooseLib.connection.readyState === 1) {
        await mongooseLib.connection.dropDatabase();
      }
    } finally {
      if (mongooseLib.connection.readyState !== 0) {
        await mongooseLib.disconnect();
      }
    }
  });

  await mongooseLib.connect(baseUri, { dbName, serverSelectionTimeoutMS: 10000 });
  await Promise.all([ProductModel.syncIndexes(), UserModel.syncIndexes()]);

  const [ownerUser, kasirUser] = await UserModel.create([
    {
      nama: 'Owner Test',
      username: `ownertest_${Date.now()}`,
      password: 'hashed_password_placeholder',
      role: 'pemilik',
    },
    {
      nama: 'Kasir Test',
      username: `kasirtest_${Date.now()}`,
      password: 'hashed_password_placeholder',
      role: 'kasir',
    },
  ]);

  const ownerToken = jwt.sign({ id: ownerUser._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const kasirToken = jwt.sign({ id: kasirUser._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  server = httpLib.createServer(expressApp);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const api = async (path, { method = 'GET', token = ownerToken, body } = {}) => {
    const headers = { Connection: 'close' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };

  // Helper mock SMTP via node:tls.connect
  const setupSmtpMock = (subtestContext) => {
    const sentMessages = [];
    subtestContext.mock.method(tls, 'connect', () => {
      const socket = new EventEmitter();
      let step = 0;
      const capturedChunks = [];

      socket.write = (line) => {
        const str = String(line);
        if (step === 0 && str.startsWith('EHLO')) {
          step = 1;
          queueMicrotask(() => socket.emit('data', Buffer.from('250 OK\r\n')));
        } else if (step === 1 && str.startsWith('AUTH LOGIN')) {
          step = 2;
          queueMicrotask(() => socket.emit('data', Buffer.from('334 VXNlcm5hbWU6\r\n')));
        } else if (step === 2) {
          step = 3;
          queueMicrotask(() => socket.emit('data', Buffer.from('334 UGFzc3dvcmQ6\r\n')));
        } else if (step === 3) {
          step = 4;
          queueMicrotask(() => socket.emit('data', Buffer.from('235 Auth OK\r\n')));
        } else if (step === 4 && str.startsWith('MAIL FROM:')) {
          step = 5;
          queueMicrotask(() => socket.emit('data', Buffer.from('250 OK\r\n')));
        } else if (step === 5 && str.startsWith('RCPT TO:')) {
          step = 6;
          queueMicrotask(() => socket.emit('data', Buffer.from('250 OK\r\n')));
        } else if (step === 6 && str.startsWith('DATA')) {
          step = 7;
          queueMicrotask(() => socket.emit('data', Buffer.from('354 End data\r\n')));
        } else if (step === 7) {
          capturedChunks.push(str);
          sentMessages.push(capturedChunks.join(''));
          step = 8;
          queueMicrotask(() => socket.emit('data', Buffer.from('250 Message accepted\r\n')));
        }
      };
      socket.end = () => {};
      socket.destroy = () => {};

      queueMicrotask(() => socket.emit('data', Buffer.from('220 smtp.gmail.com ESMTP\r\n')));
      return socket;
    });
    return sentMessages;
  };

  let createdSafeProductId;
  let createdLowProductId;
  let createdZeroProductId;

  await t.test('1. Create Product: auto/manual kodeProduk, duplikat 400, & validasi productRules', async () => {
    // 1a. Create lengkap tanpa kodeProduk -> generate PRD-<UUID>
    const resSafe = await api('/api/products', {
      method: 'POST',
      body: {
        nama: 'Beras Rojolele 5kg',
        kategori: 'Sembako',
        hargaBeli: 62000,
        hargaJual: 72000,
        stok: 20,
        satuan: 'sak',
        stokMinimum: 5,
        deskripsi: 'Beras pulen kemasan 5kg',
      },
    });
    strictAssert.equal(resSafe.status, 201);
    strictAssert.equal(resSafe.json.success, true);
    strictAssert.match(resSafe.json.data.kodeProduk, /^PRD-[0-9A-F-]+$/);
    strictAssert.equal(resSafe.json.data.satuan, 'sak');
    strictAssert.equal(resSafe.json.data.stokMinimum, 5);
    strictAssert.equal(resSafe.json.data.aktif, true);
    createdSafeProductId = resSafe.json.data._id;

    // 1b. Create dengan kodeProduk manual (lowercase + spasi) -> di-trim & uppercase
    const resLow = await api('/api/products', {
      method: 'POST',
      body: {
        nama: 'Gula Pasir Gulaku 1kg',
        kodeProduk: '  gula-001 ',
        kategori: 'Sembako',
        hargaBeli: 14000,
        hargaJual: 17500,
        stok: 3,
        satuan: 'pack',
        stokMinimum: 5,
      },
    });
    strictAssert.equal(resLow.status, 201);
    strictAssert.equal(resLow.json.data.kodeProduk, 'GULA-001');
    createdLowProductId = resLow.json.data._id;

    // 1c. Create item stok 0 untuk uji urutan low-stock
    const resZero = await api('/api/products', {
      method: 'POST',
      body: {
        nama: 'Sabun Lifebuoy Merah',
        kodeProduk: 'SBN-001',
        kategori: 'Kebutuhan Mandi',
        hargaBeli: 3500,
        hargaJual: 5000,
        stok: 0,
        satuan: 'pcs',
        stokMinimum: 4,
      },
    });
    strictAssert.equal(resZero.status, 201);
    createdZeroProductId = resZero.json.data._id;

    // 1d. Duplikat kodeProduk pada POST & PUT -> 400 dengan pesan spesifik
    const resDup = await api('/api/products', {
      method: 'POST',
      body: {
        nama: 'Gula Tiruan',
        kodeProduk: 'gula-001',
        kategori: 'Sembako',
        hargaBeli: 10000,
        hargaJual: 12000,
      },
    });
    strictAssert.equal(resDup.status, 400);
    strictAssert.equal(resDup.json.message, 'Kode produk sudah digunakan oleh produk lain');

    const resImmutablePut = await api(`/api/products/${createdZeroProductId}`, {
      method: 'PUT',
      body: { kodeProduk: 'gula-001', nama: 'Sabun Lifebuoy Merah Baru' },
    });
    strictAssert.equal(resImmutablePut.status, 200);
    strictAssert.equal(resImmutablePut.json.data.nama, 'Sabun Lifebuoy Merah Baru');
    strictAssert.equal(resImmutablePut.json.data.kodeProduk, 'SBN-001');

    const resRevertName = await api(`/api/products/${createdZeroProductId}`, {
      method: 'PUT',
      body: { nama: 'Sabun Lifebuoy Merah' },
    });
    strictAssert.equal(resRevertName.status, 200);
    strictAssert.equal(resRevertName.json.data.nama, 'Sabun Lifebuoy Merah');

    // 1e. Validasi productRules: nama kosong, angka negatif, kodeProduk spasi kosong
    const invalidPayloads = [
      { nama: '   ', hargaBeli: 1000, hargaJual: 2000 },
      { nama: 'Tes', hargaBeli: -1, hargaJual: 2000 },
      { nama: 'Tes', hargaBeli: 1000, hargaJual: -50 },
      { nama: 'Tes', hargaBeli: 1000, hargaJual: 2000, stok: -1 },
      { nama: 'Tes', hargaBeli: 1000, hargaJual: 2000, stokMinimum: -2 },
      { nama: 'Tes', kodeProduk: '   ', hargaBeli: 1000, hargaJual: 2000 },
    ];
    for (const payload of invalidPayloads) {
      const resBad = await api('/api/products', { method: 'POST', body: payload });
      strictAssert.equal(resBad.status, 400);
      strictAssert.equal(resBad.json.success, false);
    }
  });

  await t.test('2. Read & Filter Products: ?aktif, ?search, ?kategori, ?barcode, & GET /:id', async () => {
    const resDefault = await api('/api/products');
    strictAssert.equal(resDefault.status, 200);
    strictAssert.equal(resDefault.json.data.length, 3);

    const resSearchNama = await api('/api/products?search=rojolele');
    strictAssert.equal(resSearchNama.status, 200);
    strictAssert.equal(resSearchNama.json.data.length, 1);
    strictAssert.equal(resSearchNama.json.data[0]._id, createdSafeProductId);

    const resSearchKode = await api('/api/products?search=gula-001');
    strictAssert.equal(resSearchKode.status, 200);
    strictAssert.equal(resSearchKode.json.data.length, 1);
    strictAssert.equal(resSearchKode.json.data[0]._id, createdLowProductId);

    const resKategori = await api('/api/products?kategori=mandi');
    strictAssert.equal(resKategori.status, 200);
    strictAssert.equal(resKategori.json.data.length, 1);
    strictAssert.equal(resKategori.json.data[0]._id, createdZeroProductId);

    const resBarcode = await api('/api/products?barcode=SBN-001');
    strictAssert.equal(resBarcode.status, 200);
    strictAssert.equal(resBarcode.json.data.length, 1);
    strictAssert.equal(resBarcode.json.data[0].kodeProduk, 'SBN-001');

    // Detail by ID: 200, 404, 400
    const resById = await api(`/api/products/${createdLowProductId}`);
    strictAssert.equal(resById.status, 200);
    strictAssert.equal(resById.json.data.kodeProduk, 'GULA-001');

    const resNotFound = await api('/api/products/000000000000000000000000');
    strictAssert.equal(resNotFound.status, 404);

    const resBadId = await api('/api/products/bukan-object-id');
    strictAssert.equal(resBadId.status, 400);
  });

  await t.test('3. Update Product (PUT) & validasi productUpdateRules', async () => {
    const resPut = await api(`/api/products/${createdSafeProductId}`, {
      method: 'PUT',
      body: {
        nama: 'Beras Rojolele Premium 5kg',
        hargaBeli: 65000,
        hargaJual: 76000,
        stok: 25,
        satuan: 'sak',
        stokMinimum: 8,
        deskripsi: 'Update deskripsi premium',
      },
    });
    strictAssert.equal(resPut.status, 200);
    strictAssert.equal(resPut.json.data.nama, 'Beras Rojolele Premium 5kg');
    strictAssert.equal(resPut.json.data.hargaBeli, 65000);
    strictAssert.equal(resPut.json.data.hargaJual, 76000);
    strictAssert.equal(resPut.json.data.stokMinimum, 8);
    strictAssert.equal(resPut.json.data.deskripsi, 'Update deskripsi premium');

    for (const badBody of [{ hargaBeli: -10 }, { hargaJual: -1 }, { stok: -5 }, { stokMinimum: -1 }]) {
      const resInvalid = await api(`/api/products/${createdSafeProductId}`, {
        method: 'PUT',
        body: badBody,
      });
      strictAssert.equal(resInvalid.status, 400);
    }

    const resMissing = await api('/api/products/000000000000000000000000', {
      method: 'PUT',
      body: { nama: 'Tidak Ada' },
    });
    strictAssert.equal(resMissing.status, 404);
  });

  await t.test('4. Restock Product (PATCH /restock) & validasi restockRules', async () => {
    // Low item awal stok = 3 -> restock +10 = 13 (kini aman di atas stokMinimum 5)
    const resRestock = await api(`/api/products/${createdLowProductId}/restock`, {
      method: 'PATCH',
      body: { jumlah: 10 },
    });
    strictAssert.equal(resRestock.status, 200);
    strictAssert.equal(resRestock.json.data.stok, 13);

    for (const badQty of [0, -3, 'lima', null]) {
      const resBad = await api(`/api/products/${createdLowProductId}/restock`, {
        method: 'PATCH',
        body: { jumlah: badQty },
      });
      strictAssert.equal(resBad.status, 400);
    }

    const resMissing = await api('/api/products/000000000000000000000000/restock', {
      method: 'PATCH',
      body: { jumlah: 5 },
    });
    strictAssert.equal(resMissing.status, 404);

    // Kembalikan stok ke 3 lewat PUT agar tetap masuk pengujian low-stock berikut
    await api(`/api/products/${createdLowProductId}`, {
      method: 'PUT',
      body: { stok: 3 },
    });
  });

  await t.test('5. Soft Delete (DELETE) & Restore (PATCH /restore) + Filter ?aktif=false / all', async () => {
    // Nonaktifkan createdLowProductId (stok 3, low stock)
    const resSoft = await api(`/api/products/${createdLowProductId}`, {
      method: 'DELETE',
    });
    strictAssert.equal(resSoft.status, 200);
    strictAssert.equal(resSoft.json.success, true);

    // Default aktif=true tidak memuat produk nonaktif
    const resActiveOnly = await api('/api/products');
    strictAssert.equal(resActiveOnly.json.data.length, 2);
    strictAssert.equal(
      resActiveOnly.json.data.some((p) => p._id === createdLowProductId),
      false
    );

    // ?aktif=false memuat produk nonaktif
    const resInactiveOnly = await api('/api/products?aktif=false');
    strictAssert.equal(resInactiveOnly.status, 200);
    strictAssert.equal(resInactiveOnly.json.data.length, 1);
    strictAssert.equal(resInactiveOnly.json.data[0]._id, createdLowProductId);
    strictAssert.equal(resInactiveOnly.json.data[0].aktif, false);

    // ?aktif=all memuat ketiganya
    const resAll = await api('/api/products?aktif=all');
    strictAssert.equal(resAll.status, 200);
    strictAssert.equal(resAll.json.data.length, 3);

    // /low-stock wajib mengecualikan produk nonaktif
    const resLowWhileInactive = await api('/api/products/low-stock');
    strictAssert.equal(resLowWhileInactive.json.data.length, 1);
    strictAssert.equal(resLowWhileInactive.json.data[0]._id, createdZeroProductId);

    // Restore produk -> kembali aktif dan muncul lagi di /low-stock
    const resRestore = await api(`/api/products/${createdLowProductId}/restore`, {
      method: 'PATCH',
    });
    strictAssert.equal(resRestore.status, 200);
    strictAssert.equal(resRestore.json.data.aktif, true);

    const resAfterRestore = await api('/api/products');
    strictAssert.equal(resAfterRestore.json.data.length, 3);

    const resRestore404 = await api('/api/products/000000000000000000000000/restore', {
      method: 'PATCH',
    });
    strictAssert.equal(resRestore404.status, 404);
  });

  await t.test('6. Low Stock Detection (/low-stock sorting) & Manual Email Trigger (POST /low-stock/notify)', async (subtest) => {
    // Saat ini low stock aktif: Sabun (stok 0) dan Gula (stok 3); Beras aman (stok 25 > 8)
    const resLow = await api('/api/products/low-stock');
    strictAssert.equal(resLow.status, 200);
    strictAssert.equal(resLow.json.data.length, 2);
    strictAssert.equal(resLow.json.data[0]._id, createdZeroProductId);
    strictAssert.equal(resLow.json.data[1]._id, createdLowProductId);
    strictAssert.equal(typeof resLow.json.data[0].hargaBeli, 'number');

    // Kasir tidak boleh melihat hargaBeli pada GET /api/products/low-stock
    const resLowKasir = await api('/api/products/low-stock', { token: kasirToken });
    strictAssert.equal(resLowKasir.status, 200);
    strictAssert.equal(resLowKasir.json.data.length, 2);
    strictAssert.equal(resLowKasir.json.data[0].hargaBeli, undefined);
    strictAssert.equal(resLowKasir.json.data[1].hargaBeli, undefined);

    // Setup env SMTP sementara + mock tls.connect
    const prevEnv = {
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      OWNER_EMAIL: process.env.OWNER_EMAIL,
    };
    process.env.SMTP_USER = 'bot@stockart.local';
    process.env.SMTP_PASS = 'secretapppass';
    process.env.OWNER_EMAIL = 'owner@stockart.local';

    const sentMessages = setupSmtpMock(subtest);

    try {
      const resNotify = await api('/api/products/low-stock/notify', {
        method: 'POST',
        body: { email: 'custom-owner@stockart.local' },
      });
      strictAssert.equal(resNotify.status, 200);
      strictAssert.equal(resNotify.json.success, true);
      strictAssert.equal(resNotify.json.data.sent, true);
      strictAssert.equal(resNotify.json.data.count, 2);
      strictAssert.equal(resNotify.json.data.recipient, 'custom-owner@stockart.local');
      strictAssert.equal(sentMessages.length, 1);

      // Verifikasi subject & HTML MIME payload bebas emoji
      const mime = sentMessages[0];
      const subjectMatch = mime.match(/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/);
      strictAssert.ok(subjectMatch, 'Header Subject MIME harus ter-encode Base64 UTF-8');
      const decodedSubject = Buffer.from(subjectMatch[1], 'base64').toString('utf8');
      strictAssert.match(decodedSubject, /^\[Stockart Kritis\]/);
      strictAssert.equal(/[\p{Extended_Pictographic}\u2600-\u27BF]/u.test(decodedSubject), false);

      const parts = mime.split('\r\n\r\n');
      const htmlBase64 = (parts[1] || '').replace(/\r\n\.$/, '').replace(/\s+/g, '');
      const decodedHtml = Buffer.from(htmlBase64, 'base64').toString('utf8');
      strictAssert.match(decodedHtml, /Sabun Lifebuoy Merah/);
      strictAssert.match(decodedHtml, /Gula Pasir Gulaku 1kg/);
      strictAssert.equal(/[\p{Extended_Pictographic}\u2600-\u27BF]/u.test(decodedHtml), false);

      // Uji kondisi semua stok aman -> sent: false, count: 0
      await api(`/api/products/${createdZeroProductId}`, { method: 'PUT', body: { stok: 50 } });
      await api(`/api/products/${createdLowProductId}`, { method: 'PUT', body: { stok: 50 } });

      const resNoLow = await api('/api/products/low-stock/notify', { method: 'POST' });
      strictAssert.equal(resNoLow.status, 200);
      strictAssert.equal(resNoLow.json.data.sent, false);
      strictAssert.equal(resNoLow.json.data.count, 0);
      strictAssert.equal(sentMessages.length, 1);
    } finally {
      process.env.SMTP_USER = prevEnv.SMTP_USER;
      process.env.SMTP_PASS = prevEnv.SMTP_PASS;
      process.env.OWNER_EMAIL = prevEnv.OWNER_EMAIL;
    }
  });

  await t.test('7. Create/Update/Restock tidak lagi mengirim email ketengan, dan restock/update me-reset flag stok habis', async (subtest) => {
    const prevNodeTestContext = process.env.NODE_TEST_CONTEXT;
    const prevSmtpUser = process.env.SMTP_USER;
    const prevSmtpPass = process.env.SMTP_PASS;
    const prevOwnerEmail = process.env.OWNER_EMAIL;

    delete process.env.NODE_TEST_CONTEXT;
    process.env.SMTP_USER = 'bot@stockart.local';
    process.env.SMTP_PASS = 'secretapppass';
    process.env.OWNER_EMAIL = 'owner@stockart.local';

    const sentMessages = setupSmtpMock(subtest);

    const waitTicks = () => new Promise((resolve) => setTimeout(resolve, 40));

    try {
      // POST stok aman -> tidak kirim email
      const resPostSafe = await api('/api/products', {
        method: 'POST',
        body: {
          nama: 'Teh Celup Aman',
          hargaBeli: 5000,
          hargaJual: 7000,
          stok: 12,
          stokMinimum: 3,
        },
      });
      strictAssert.equal(resPostSafe.status, 201);
      await waitTicks();
      strictAssert.equal(sentMessages.length, 0);

      // POST stok <= stokMinimum -> tidak lagi kirim email otomatis (ditampung ke digest)
      const resPostLow = await api('/api/products', {
        method: 'POST',
        body: {
          nama: 'Kopi Sachet Kritis',
          hargaBeli: 10000,
          hargaJual: 13000,
          stok: 2,
          stokMinimum: 5,
        },
      });
      strictAssert.equal(resPostLow.status, 201);
      await waitTicks();
      strictAssert.equal(sentMessages.length, 0);

      // Simulasikan produk pernah terkirim alert kritis stok habis
      await ProductModel.updateOne(
        { _id: resPostLow.json.data._id },
        { $set: { stok: 0, stokHabisNotifiedAt: new Date() } }
      );

      // PATCH /restock -> tidak kirim email dan me-reset stokHabisNotifiedAt ke null
      const resRestockLow = await api(`/api/products/${resPostLow.json.data._id}/restock`, {
        method: 'PATCH',
        body: { jumlah: 2 },
      });
      strictAssert.equal(resRestockLow.status, 200);
      strictAssert.equal(resRestockLow.json.data.stok, 2);
      strictAssert.equal(resRestockLow.json.data.stokHabisNotifiedAt, null);
      await waitTicks();
      strictAssert.equal(sentMessages.length, 0);

      // PUT mengubah stok ke low -> tidak kirim email otomatis; bila stok > 0 juga reset flag habis
      await ProductModel.updateOne(
        { _id: resPostSafe.json.data._id },
        { $set: { stokHabisNotifiedAt: new Date() } }
      );
      const resPutLow = await api(`/api/products/${resPostSafe.json.data._id}`, {
        method: 'PUT',
        body: { stok: 1 },
      });
      strictAssert.equal(resPutLow.status, 200);
      strictAssert.equal(resPutLow.json.data.stokHabisNotifiedAt, null);
      await waitTicks();
      strictAssert.equal(sentMessages.length, 0);
    } finally {
      if (prevNodeTestContext !== undefined) {
        process.env.NODE_TEST_CONTEXT = prevNodeTestContext;
      }
      process.env.SMTP_USER = prevSmtpUser;
      process.env.SMTP_PASS = prevSmtpPass;
      process.env.OWNER_EMAIL = prevOwnerEmail;
    }
  });

  await t.test('8. Hard Delete (?permanent=true) & RBAC End-to-End (Unauth 401, Kasir 403 mutasi / 200 read)', async () => {
    // Hard delete
    const resHard = await api(`/api/products/${createdZeroProductId}?permanent=true`, {
      method: 'DELETE',
    });
    strictAssert.equal(resHard.status, 200);

    const resAfterHard = await api(`/api/products/${createdZeroProductId}`);
    strictAssert.equal(resAfterHard.status, 404);

    const resHardMissing = await api('/api/products/000000000000000000000000?permanent=true', {
      method: 'DELETE',
    });
    strictAssert.equal(resHardMissing.status, 404);

    // Unauthenticated -> 401
    const resUnauth = await api('/api/products', { token: null });
    strictAssert.equal(resUnauth.status, 401);

    // Kasir boleh GET semua endpoint baca
    const kasirReads = [
      '/api/products',
      '/api/products/low-stock',
      `/api/products/${createdLowProductId}`,
    ];
    for (const endpoint of kasirReads) {
      const r = await api(endpoint, { token: kasirToken });
      strictAssert.equal(r.status, 200, `Kasir harus diizinkan GET ${endpoint}`);
    }

    // Kasir ditolak 403 di seluruh endpoint mutasi product
    const kasirForbidden = [
      { method: 'POST', path: '/api/products', body: { nama: 'X', hargaBeli: 1, hargaJual: 2 } },
      { method: 'PUT', path: `/api/products/${createdLowProductId}`, body: { nama: 'Y' } },
      { method: 'PATCH', path: `/api/products/${createdLowProductId}/restock`, body: { jumlah: 5 } },
      { method: 'PATCH', path: `/api/products/${createdLowProductId}/restore` },
      { method: 'DELETE', path: `/api/products/${createdLowProductId}` },
      { method: 'DELETE', path: `/api/products/${createdLowProductId}?permanent=true` },
      { method: 'POST', path: '/api/products/low-stock/notify' },
    ];
    for (const reqSpec of kasirForbidden) {
      const r = await api(reqSpec.path, {
        method: reqSpec.method,
        token: kasirToken,
        body: reqSpec.body,
      });
      strictAssert.equal(
        r.status,
        403,
        `Kasir harus ditolak 403 pada ${reqSpec.method} ${reqSpec.path}`
      );
    }
  });
});

test('validasi barcode: opsional, 4–48 karakter tanpa spasi', () => {
  const { productUpdateRules } = require('../middleware/validate');
  for (const barcode of [undefined, null, '', '   ', '8991234567890', 'ABCD', 'x'.repeat(48)]) {
    assert.deepEqual(productRules({ ...payload, barcode }), [], `barcode ${JSON.stringify(barcode)} harus lolos`);
    assert.deepEqual(productUpdateRules({ barcode }), [], `update barcode ${JSON.stringify(barcode)} harus lolos`);
  }
  for (const barcode of ['abc', 'x'.repeat(49), '899 123', 8991234567890, {}, []]) {
    assert.ok(productRules({ ...payload, barcode }).length, `barcode ${JSON.stringify(barcode)} harus ditolak`);
    assert.ok(productUpdateRules({ barcode }).length, `update barcode ${JSON.stringify(barcode)} harus ditolak`);
  }
});

test('HTTP: barcode unik, sparse, dan dapat dihapus lewat update', async (t) => {
  const dbName = `prd_bc_${process.pid}_${Date.now()}`;
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  });
  await Promise.all([Product.init(), User.init()]);
  const owner = await User.create({ nama: 'Owner barcode', username: 'barcode_test_owner',
    password: 'test-only', role: 'pemilik' });
  const token = jwt.sign({ id: owner._id }, process.env.JWT_SECRET, { expiresIn: '5m' });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/products`;
  async function request(method, path, body) {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  }

  // Barcode valid berhasil disimpan (dengan trim).
  const withBarcode = await request('POST', '', { ...payload, barcode: ' 8991234567890 ' });
  assert.equal(withBarcode.status, 201, JSON.stringify(withBarcode));
  assert.equal(withBarcode.data.barcode, '8991234567890');

  // Barcode sama kedua kali ditolak dengan pesan jelas.
  const duplicate = await request('POST', '', { ...payload, barcode: '8991234567890' });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.message, 'Barcode sudah digunakan oleh produk lain');

  // Produk tanpa barcode (tidak dikirim / string kosong) tidak saling bentrok.
  const noBarcodeA = await request('POST', '', payload);
  const noBarcodeB = await request('POST', '', { ...payload, barcode: '' });
  assert.equal(noBarcodeA.status, 201, JSON.stringify(noBarcodeA));
  assert.equal(noBarcodeB.status, 201, JSON.stringify(noBarcodeB));
  assert.equal(noBarcodeA.data.barcode, undefined);
  assert.equal(noBarcodeB.data.barcode, undefined);

  // Update ke barcode milik produk lain ditolak.
  const dupUpdate = await request('PUT', `/${noBarcodeA.data._id}`, { barcode: '8991234567890' });
  assert.equal(dupUpdate.status, 400);
  assert.equal(dupUpdate.message, 'Barcode sudah digunakan oleh produk lain');

  // Update barcode "" → field dihapus (bukan disimpan ""), barcode jadi bebas dipakai lagi.
  const cleared = await request('PUT', `/${withBarcode.data._id}`, { barcode: '' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared));
  assert.equal(cleared.data.barcode, undefined);
  assert.equal(await Product.countDocuments({ barcode: { $exists: true } }), 0);
  const reused = await request('PUT', `/${noBarcodeA.data._id}`, { barcode: '8991234567890' });
  assert.equal(reused.status, 200, JSON.stringify(reused));
  assert.equal(reused.data.barcode, '8991234567890');

  // Update tanpa menyentuh barcode tidak menghapusnya.
  const renamed = await request('PUT', `/${noBarcodeA.data._id}`, { nama: 'Nama baru' });
  assert.equal(renamed.data.barcode, '8991234567890');

  // Pesan duplikat kodeProduk tetap seperti semula.
  const kode = { ...payload, kodeProduk: 'BC-KODE-001' };
  assert.equal((await request('POST', '', kode)).status, 201);
  const dupKode = await request('POST', '', kode);
  assert.equal(dupKode.status, 400);
  assert.equal(dupKode.message, 'Kode produk sudah digunakan oleh produk lain');
});

test('HTTP: lookup barcode (GET /barcode/:code) dan filter ?barcode=', async (t) => {
  const dbName = `prd_bcl_${process.pid}_${Date.now()}`;
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 10000 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  });
  await Promise.all([Product.init(), User.init()]);
  const [owner, kasir] = await User.create([
    { nama: 'Owner lookup', username: 'lookup_owner', password: 'test-only', role: 'pemilik' },
    { nama: 'Kasir lookup', username: 'lookup_kasir', password: 'test-only', role: 'kasir' },
  ]);
  const ownerToken = jwt.sign({ id: owner._id }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const kasirToken = jwt.sign({ id: kasir._id }, process.env.JWT_SECRET, { expiresIn: '5m' });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/products`;
  async function get(path, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(base + path, { headers });
    return { status: response.status, ...(await response.json()) };
  }

  const aktif = await Product.create({ ...payload, nama: 'Aktif', barcode: '8990001112223' });
  await Product.create({ ...payload, nama: 'Nonaktif', barcode: '8990009998887', aktif: false });
  const lama = await Product.create({ ...payload, nama: 'Data lama', kodeProduk: 'LAMA-001' });

  // Kasir: produk aktif ketemu tanpa hargaBeli.
  const kasirHit = await get('/barcode/8990001112223', kasirToken);
  assert.equal(kasirHit.status, 200, JSON.stringify(kasirHit));
  assert.equal(kasirHit.data._id, String(aktif._id));
  assert.equal(kasirHit.data.hargaBeli, undefined);
  assert.equal(kasirHit.data.hargaJual, payload.hargaJual);

  // Kasir: produk nonaktif → 404.
  const kasirNonaktif = await get('/barcode/8990009998887', kasirToken);
  assert.equal(kasirNonaktif.status, 404);
  assert.equal(kasirNonaktif.message, 'Produk dengan barcode ini belum terdaftar');

  // Pemilik: hargaBeli tampil.
  const ownerHit = await get('/barcode/8990001112223', ownerToken);
  assert.equal(ownerHit.status, 200);
  assert.equal(ownerHit.data.hargaBeli, payload.hargaBeli);

  // Tanpa token → 401. Kode asal-asalan → 404.
  assert.equal((await get('/barcode/8990001112223')).status, 401);
  const ngawur = await get('/barcode/asal-asalan-123', kasirToken);
  assert.equal(ngawur.status, 404);
  assert.equal(ngawur.success, false);
  assert.equal(ngawur.message, 'Produk dengan barcode ini belum terdaftar');

  // Data lama tanpa barcode tetap ketemu lewat kodeProduk (termasuk huruf kecil + spasi).
  const viaKode = await get(`/barcode/${encodeURIComponent(' lama-001 ')}`, kasirToken);
  assert.equal(viaKode.status, 200, JSON.stringify(viaKode));
  assert.equal(viaKode.data._id, String(lama._id));

  // Barcode diutamakan bila kode sama dengan kodeProduk produk lain.
  const bentrokKode = await Product.create({ ...payload, nama: 'Kode bentrok', kodeProduk: 'KODE-BENTROK' });
  const bentrokBarcode = await Product.create({ ...payload, nama: 'Barcode bentrok', barcode: 'KODE-BENTROK' });
  const prioritas = await get('/barcode/KODE-BENTROK', ownerToken);
  assert.equal(prioritas.data._id, String(bentrokBarcode._id));
  assert.notEqual(prioritas.data._id, String(bentrokKode._id));

  // GET /:id biasa masih berfungsi (rute tidak bentrok).
  const byId = await get(`/${aktif._id}`, kasirToken);
  assert.equal(byId.status, 200);
  assert.equal(byId.data._id, String(aktif._id));

  // ?barcode= mencocokkan barcode ATAU kodeProduk; kasir tidak melihat nonaktif.
  const listBarcode = await get('?barcode=8990001112223', kasirToken);
  assert.deepEqual(listBarcode.data.map((p) => p._id), [String(aktif._id)]);
  assert.equal(listBarcode.data[0].hargaBeli, undefined);
  const listKode = await get('?barcode=LAMA-001', kasirToken);
  assert.deepEqual(listKode.data.map((p) => p._id), [String(lama._id)]);
  assert.equal((await get('?barcode=8990009998887', kasirToken)).data.length, 0);
  // barcode + search digabung (AND), tidak saling menimpa.
  assert.equal((await get('?barcode=8990001112223&search=Aktif', ownerToken)).data.length, 1);
  assert.equal((await get('?barcode=8990001112223&search=Tidakada', ownerToken)).data.length, 0);
});
