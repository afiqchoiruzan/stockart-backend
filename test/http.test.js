/**
 * HTTP Integration Test — Product & Transaction Endpoints
 *
 * Menguji endpoint nyata via HTTP menggunakan Node.js built-in test runner
 * dan fetch (tersedia sejak Node 18). Server dijalankan pada port acak
 * sehingga tidak bentrok dengan instansi dev yang sedang berjalan.
 *
 * Prasyarat:
 *   - File .env berisi MONGO_URI dan JWT_SECRET yang valid.
 *   - Akun pemilik sudah dibuat via `node scripts/seed.js`.
 *   - Sudah ada minimal 1 kasir terdaftar (register publik).
 *
 * Jalankan:
 *   npm test          (menjalankan seluruh test termasuk file ini)
 *   node --test test/http.test.js   (standalone)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const app = require('../app');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Mulai server pada port acak, kembalikan { server, baseUrl } */
async function startServer() {
  await mongoose.connect(process.env.MONGO_URI);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://localhost:${port}` };
}

/** Matikan server dan putuskan koneksi Mongoose */
async function stopServer(server) {
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  await mongoose.disconnect();
}

/**
 * Kirim HTTP request dan kembalikan { status, body }.
 * @param {string} baseUrl
 * @param {string} method  - GET | POST | PUT | PATCH | DELETE
 * @param {string} path    - mis. "/api/products"
 * @param {object} [opts]
 * @param {string} [opts.token]  - Bearer token (opsional)
 * @param {object} [opts.body]   - Request body JSON (opsional)
 */
async function req(baseUrl, method, path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

/** Login dan kembalikan token JWT. Lempar error jika login gagal. */
async function login(baseUrl, username, password) {
  const { status, body } = await req(baseUrl, 'POST', '/api/auth/login', {
    body: { username, password },
  });
  assert.equal(status, 200, `Login "${username}" gagal: ${JSON.stringify(body)}`);
  return body.data.token;
}

// ─── Kredensial ─────────────────────────────────────────────────────────────

// User sementara — dibuat di test setup dan dihapus di teardown
const PEMILIK_TEST_USERNAME = `pemilik_test_${Date.now()}`;
const PEMILIK_TEST_PASSWORD = 'pemilikPassword123';
const KASIR_TEST_USERNAME = `kasir_test_${Date.now()}`;
const KASIR_TEST_PASSWORD = 'testPassword123';

// ─── Setup & Teardown ────────────────────────────────────────────────────────

let server;
let baseUrl;
let tokenPemilik;
let tokenKasir;
let createdProductId;    // ID produk yang dibuat selama test
let createdTransactionId; // ID transaksi yang dibuat selama test

// Setup: jalankan server, buat user pemilik & kasir sementara, login keduanya
test('Setup: server & autentikasi', async () => {
  ({ server, baseUrl } = await startServer());

  // Buat akun pemilik sementara langsung di DB
  const hashedPemilikPassword = await bcrypt.hash(PEMILIK_TEST_PASSWORD, 10);
  await User.create({
    nama: 'Pemilik Test',
    username: PEMILIK_TEST_USERNAME,
    password: hashedPemilikPassword,
    role: 'pemilik',
  });

  // Login pemilik terlebih dahulu untuk mendapatkan token pemilik
  tokenPemilik = await login(baseUrl, PEMILIK_TEST_USERNAME, PEMILIK_TEST_PASSWORD);

  // Pemilik mendaftarkan kasir sementara
  const { status: regStatus, body: regBody } = await req(
    baseUrl,
    'POST',
    '/api/auth/register',
    {
      token: tokenPemilik,
      body: { nama: 'Kasir Test', username: KASIR_TEST_USERNAME, password: KASIR_TEST_PASSWORD },
    }
  );
  assert.equal(regStatus, 201, `Register kasir gagal: ${JSON.stringify(regBody)}`);

  // Login kasir untuk mendapatkan tokenKasir
  tokenKasir = await login(baseUrl, KASIR_TEST_USERNAME, KASIR_TEST_PASSWORD);
});

// ─── Profile Tests ───────────────────────────────────────────────────────────

test('GET /api/auth/me — tanpa token ditolak (401)', async () => {
  const { status } = await req(baseUrl, 'GET', '/api/auth/me');
  assert.equal(status, 401);
});

test('GET /api/auth/me — pemilik dapat melihat profil diri (200)', async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/auth/me', {
    token: tokenPemilik,
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.data.username, PEMILIK_TEST_USERNAME);
  assert.equal(body.data.role, 'pemilik');
});

test('GET /api/auth/me — kasir dapat melihat profil diri (200)', async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/auth/me', {
    token: tokenKasir,
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.data.username, KASIR_TEST_USERNAME);
  assert.equal(body.data.role, 'kasir');
});

// ─── Product Tests ───────────────────────────────────────────────────────────

test('GET /api/products — kasir dapat melihat daftar produk', async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/products', {
    token: tokenKasir,
  });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data), 'data harus berupa array');
});

test('GET /api/products — pemilik dapat melihat daftar produk', async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/products', {
    token: tokenPemilik,
  });
  assert.equal(status, 200);
  assert.equal(body.success, true);
});

test('GET /api/products — tanpa token ditolak (401)', async () => {
  const { status } = await req(baseUrl, 'GET', '/api/products');
  assert.equal(status, 401);
});

test('POST /api/products — kasir TIDAK BISA tambah produk (403)', async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/products', {
    token: tokenKasir,
    body: {
      nama: 'Produk Test Kasir',
      kodeProduk: `TEST-K-${Date.now()}`,
      hargaBeli: 5000,
      hargaJual: 7000,
      stok: 10,
    },
  });
  assert.equal(status, 403, `Kasir seharusnya ditolak, dapat: ${status} — ${JSON.stringify(body)}`);
});

test('POST /api/products — pemilik BISA tambah produk (201)', async () => {
  const kode = `TEST-P-${Date.now()}`;
  const { status, body } = await req(baseUrl, 'POST', '/api/products', {
    token: tokenPemilik,
    body: {
      nama: 'Produk Test HTTP',
      kodeProduk: kode,
      kategori: 'Test',
      hargaBeli: 10000,
      hargaJual: 15000,
      stok: 50,
      satuan: 'pcs',
      stokMinimum: 5,
    },
  });
  assert.equal(status, 201, `Produk gagal dibuat: ${JSON.stringify(body)}`);
  assert.equal(body.success, true);
  assert.ok(body.data._id, 'harus ada _id pada produk baru');
  createdProductId = body.data._id;
});

test('GET /api/products/:id — kasir dapat melihat detail produk', async () => {
  assert.ok(createdProductId, 'productId belum tersedia dari test sebelumnya');
  const { status, body } = await req(
    baseUrl,
    'GET',
    `/api/products/${createdProductId}`,
    { token: tokenKasir }
  );
  assert.equal(status, 200);
  assert.equal(body.data._id, createdProductId);
});

test('PUT /api/products/:id — kasir TIDAK BISA update produk (403)', async () => {
  assert.ok(createdProductId);
  const { status } = await req(
    baseUrl,
    'PUT',
    `/api/products/${createdProductId}`,
    { token: tokenKasir, body: { nama: 'Coba Ubah' } }
  );
  assert.equal(status, 403);
});

test('PUT /api/products/:id — pemilik BISA update produk (200)', async () => {
  assert.ok(createdProductId);
  const { status, body } = await req(
    baseUrl,
    'PUT',
    `/api/products/${createdProductId}`,
    { token: tokenPemilik, body: { nama: 'Produk Test HTTP (Updated)', hargaJual: 16000 } }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.nama, 'Produk Test HTTP (Updated)');
});

// ─── Barcode Tests ───────────────────────────────────────────────────────────

const TEST_BARCODE = `TESTBC${Date.now()}`;

test('PUT /api/products/:id — pemilik BISA memasang barcode (200)', async () => {
  assert.ok(createdProductId);
  const { status, body } = await req(
    baseUrl,
    'PUT',
    `/api/products/${createdProductId}`,
    { token: tokenPemilik, body: { barcode: TEST_BARCODE } }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.barcode, TEST_BARCODE);
});

test('GET /api/products/barcode/:code — tanpa token ditolak (401)', async () => {
  const { status } = await req(baseUrl, 'GET', `/api/products/barcode/${TEST_BARCODE}`);
  assert.equal(status, 401);
});

test('GET /api/products/barcode/:code — kasir dapat menemukan produk tanpa hargaBeli (200)', async () => {
  const { status, body } = await req(
    baseUrl,
    'GET',
    `/api/products/barcode/${TEST_BARCODE}`,
    { token: tokenKasir }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.data._id, createdProductId);
  assert.equal(body.data.hargaBeli, undefined, 'kasir tidak boleh melihat hargaBeli');
});

test('GET /api/products/barcode/:code — pemilik melihat hargaBeli (200)', async () => {
  const { status, body } = await req(
    baseUrl,
    'GET',
    `/api/products/barcode/${TEST_BARCODE}`,
    { token: tokenPemilik }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.hargaBeli, 10000);
});

test('GET /api/products/barcode/:code — kode tidak terdaftar (404)', async () => {
  const { status, body } = await req(
    baseUrl,
    'GET',
    `/api/products/barcode/TIDAKADA${Date.now()}`,
    { token: tokenKasir }
  );
  assert.equal(status, 404);
  assert.equal(body.message, 'Produk dengan barcode ini belum terdaftar');
});

test('GET /api/products?barcode= — kasir dapat memfilter dengan barcode (200)', async () => {
  const { status, body } = await req(
    baseUrl,
    'GET',
    `/api/products?barcode=${TEST_BARCODE}`,
    { token: tokenKasir }
  );
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((p) => p._id), [createdProductId]);
  assert.equal(body.data[0].hargaBeli, undefined);
});

test('GET /api/products?search= — kasir dapat mencari lewat barcode di parameter search (200)', async () => {
  const partialBarcode = TEST_BARCODE.slice(0, 8);
  const { status, body } = await req(
    baseUrl,
    'GET',
    `/api/products?search=${partialBarcode}`,
    { token: tokenKasir }
  );
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((p) => p._id), [createdProductId]);
  assert.equal(body.data[0].hargaBeli, undefined);
});

test('PUT /api/products/:id — barcode kosong menghapus barcode (200)', async () => {
  assert.ok(createdProductId);
  const { status, body } = await req(
    baseUrl,
    'PUT',
    `/api/products/${createdProductId}`,
    { token: tokenPemilik, body: { barcode: '' } }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.barcode, undefined);
});

// ─── Transaction Tests ───────────────────────────────────────────────────────

test('POST /api/transactions/draft — kasir dapat menghitung draft (200)', async () => {
  assert.ok(createdProductId);
  const { status, body } = await req(
    baseUrl,
    'POST',
    '/api/transactions/draft',
    {
      token: tokenKasir,
      body: { detailBarang: [{ produk: createdProductId, jumlah: 2 }] },
    }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.ok(body.data.totalHarga >= 0);
});

test('POST /api/transactions/draft — tanpa token ditolak (401)', async () => {
  const { status } = await req(baseUrl, 'POST', '/api/transactions/draft', {
    body: { detailBarang: [{ produk: createdProductId, jumlah: 1 }] },
  });
  assert.equal(status, 401);
});

test('POST /api/transactions — kasir BISA membuat transaksi (201)', async () => {
  assert.ok(createdProductId);
  const { status, body } = await req(baseUrl, 'POST', '/api/transactions', {
    token: tokenKasir,
    body: { detailBarang: [{ produk: createdProductId, jumlah: 1 }] },
  });
  assert.equal(status, 201, `Transaksi gagal dibuat: ${JSON.stringify(body)}`);
  assert.equal(body.success, true);
  assert.ok(body.data._id);
  createdTransactionId = body.data._id;
});

test('GET /api/transactions — kasir dapat melihat riwayat transaksi (200)', async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/transactions', {
    token: tokenKasir,
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.data));
});

test('GET /api/transactions/:id — kasir dapat melihat detail transaksi (200)', async () => {
  assert.ok(createdTransactionId);
  const { status, body } = await req(
    baseUrl,
    'GET',
    `/api/transactions/${createdTransactionId}`,
    { token: tokenKasir }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data._id, createdTransactionId);
});

test('PATCH /api/transactions/:id/cancel — kasir TIDAK BISA cancel transaksi (403)', async () => {
  assert.ok(createdTransactionId);
  const { status } = await req(
    baseUrl,
    'PATCH',
    `/api/transactions/${createdTransactionId}/cancel`,
    { token: tokenKasir }
  );
  assert.equal(status, 403);
});

test('PATCH /api/transactions/:id/cancel — pemilik BISA cancel transaksi (200)', async () => {
  assert.ok(createdTransactionId);
  const { status, body } = await req(
    baseUrl,
    'PATCH',
    `/api/transactions/${createdTransactionId}/cancel`,
    { token: tokenPemilik }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
});

// ─── Report Tests ────────────────────────────────────────────────────────────

test('GET /api/reports/summary — tanpa token ditolak (401)', async () => {
  const { status } = await req(baseUrl, 'GET', '/api/reports/summary');
  assert.equal(status, 401);
});

test('GET /api/reports/summary — kasir TIDAK BISA akses laporan (403)', async () => {
  const { status } = await req(baseUrl, 'GET', '/api/reports/summary', {
    token: tokenKasir,
  });
  assert.equal(status, 403);
});

test('GET /api/reports/summary — pemilik BISA akses ringkasan laporan (200)', async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/reports/summary', {
    token: tokenPemilik,
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.ok(typeof body.data.totalProduk === 'number');
  assert.ok(typeof body.data.totalTransaksi === 'number');
  assert.ok(typeof body.data.totalOmzet === 'number');
});

test('GET /api/reports/revenue — pemilik BISA akses laporan omzet (200)', async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/reports/revenue', {
    token: tokenPemilik,
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data));
});

test('GET /api/reports/revenue?interval=jam — pemilik BISA akses omzet per jam (200)', async () => {
  const { status, body } = await req(
    baseUrl,
    'GET',
    '/api/reports/revenue?interval=jam&tanggalMulai=2026-11-16&tanggalAkhir=2026-11-16',
    { token: tokenPemilik }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data));
  for (const item of body.data) {
    assert.match(item.jam, /^\d{2}$/);
    assert.ok(typeof item.omzet === 'number');
  }
});

test('GET /api/reports/revenue — interval tidak valid ditolak (400)', async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/reports/revenue?interval=minggu', {
    token: tokenPemilik,
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(body.success, false);
});

test('GET /api/reports/top-products — pemilik BISA akses laporan top products (200)', async () => {
  const { status, body } = await req(baseUrl, 'GET', '/api/reports/top-products', {
    token: tokenPemilik,
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data));
});

// ─── Register RBAC & Validation Tests ────────────────────────────────────────

test('POST /api/auth/register — tanpa token ditolak (401)', async () => {
  const { status } = await req(baseUrl, 'POST', '/api/auth/register', {
    body: { nama: 'Staff Baru', username: 'staff01', password: 'password123' },
  });
  assert.equal(status, 401);
});

test('POST /api/auth/register — kasir TIDAK BISA daftarkan user baru (403)', async () => {
  const { status } = await req(baseUrl, 'POST', '/api/auth/register', {
    token: tokenKasir,
    body: { nama: 'Staff Baru', username: 'staff01', password: 'password123' },
  });
  assert.equal(status, 403);
});

test('POST /api/auth/register — pemilik BISA daftarkan kasir baru (201)', async () => {
  const newKasirUsername = `kasir_baru_${Date.now()}`;
  const { status, body } = await req(baseUrl, 'POST', '/api/auth/register', {
    token: tokenPemilik,
    body: { nama: 'Kasir Resmi Toko', username: newKasirUsername, password: 'password123' },
  });
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.data.role, 'kasir');
  // Bersihkan data user yang baru dibuat
  await User.findByIdAndDelete(body.data._id);
});

test('POST /api/auth/register — password kurang dari 8 karakter ditolak (400)', async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/auth/register', {
    token: tokenPemilik,
    body: { nama: 'Test', username: 'testuser123', password: 'abc' },
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(body.success, false);
  assert.ok(Array.isArray(body.errors), 'harus ada array errors');
  assert.ok(body.errors.some((e) => e.includes('password')));
});

test('POST /api/auth/register — username tidak valid (spasi/simbol) ditolak (400)', async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/auth/register', {
    token: tokenPemilik,
    body: { nama: 'Test', username: 'user name!', password: 'password123' },
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(body.errors.some((e) => e.includes('username')));
});

test('POST /api/auth/register — tanpa field wajib ditolak (400)', async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/auth/register', {
    token: tokenPemilik,
    body: {},
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(body.errors.length >= 3, 'harus ada 3 error (nama, username, password)');
});

test('POST /api/auth/login — tanpa body ditolak (400)', async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/auth/login', {
    body: {},
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(body.errors.length >= 2, 'harus ada error username dan password');
});

test('POST /api/products — kodeProduk kosong ditolak (400)', async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/products', {
    token: tokenPemilik,
    body: { nama: 'Produk Kode Kosong', kodeProduk: '', hargaBeli: 1000, hargaJual: 2000 },
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(body.errors.some((e) => e.includes('kodeProduk')));
});

test('POST /api/products — hargaJual negatif ditolak (400)', async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/products', {
    token: tokenPemilik,
    body: { nama: 'Test', kodeProduk: 'KODE-NEG', hargaBeli: 1000, hargaJual: -500 },
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(body.errors.some((e) => e.includes('hargaJual')));
});

test('POST /api/transactions — detailBarang kosong ditolak (400)', async () => {
  const { status, body } = await req(baseUrl, 'POST', '/api/transactions', {
    token: tokenKasir,
    body: { detailBarang: [] },
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(body.errors.some((e) => e.includes('detailBarang')));
});

test('POST /api/transactions — jumlah item 0 ditolak (400)', async () => {
  assert.ok(createdProductId);
  const { status, body } = await req(baseUrl, 'POST', '/api/transactions', {
    token: tokenKasir,
    body: { detailBarang: [{ produk: createdProductId, jumlah: 0 }] },
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(body.errors.some((e) => e.includes('jumlah')));
});

// ─── Soft Delete & Restore Tests ─────────────────────────────────────────────

test('DELETE /api/products/:id — kasir TIDAK BISA hapus produk (403)', async () => {
  const { status } = await req(
    baseUrl,
    'DELETE',
    `/api/products/${createdProductId}`,
    { token: tokenKasir }
  );
  assert.equal(status, 403);
});

test('DELETE /api/products/:id — pemilik BISA soft delete produk (200)', async () => {
  // Buat produk sementara untuk diuji soft delete
  const { body: newProd } = await req(baseUrl, 'POST', '/api/products', {
    token: tokenPemilik,
    body: {
      nama: 'Produk Uji Soft Delete',
      kodeProduk: `SD-${Date.now()}`,
      hargaBeli: 2000,
      hargaJual: 3000,
      stok: 10,
    },
  });
  const tempId = newProd.data._id;

  // Soft delete produk
  const { status, body } = await req(
    baseUrl,
    'DELETE',
    `/api/products/${tempId}`,
    { token: tokenPemilik }
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.message, 'Produk berhasil dinonaktifkan');

  // Verifikasi produk berstatus aktif: false
  const { body: detail } = await req(
    baseUrl,
    'GET',
    `/api/products/${tempId}`,
    { token: tokenKasir }
  );
  assert.equal(detail.data.aktif, false);

  // Restore produk kembali aktif
  const { status: restoreStatus, body: restoreBody } = await req(
    baseUrl,
    'PATCH',
    `/api/products/${tempId}/restore`,
    { token: tokenPemilik }
  );
  assert.equal(restoreStatus, 200, JSON.stringify(restoreBody));
  assert.equal(restoreBody.success, true);
  assert.equal(restoreBody.data.aktif, true);

  // Hapus permanen
  const { status: permStatus } = await req(
    baseUrl,
    'DELETE',
    `/api/products/${tempId}?permanent=true`,
    { token: tokenPemilik }
  );
  assert.equal(permStatus, 200);

  // Verifikasi 404 setelah hapus permanen
  const { status: notFoundStatus } = await req(
    baseUrl,
    'GET',
    `/api/products/${tempId}`,
    { token: tokenKasir }
  );
  assert.equal(notFoundStatus, 404);
});

// ─── Teardown ────────────────────────────────────────────────────────────────

test('Teardown: hapus data test & tutup server', async () => {
  if (createdTransactionId) await Transaction.deleteOne({ _id: createdTransactionId });

  // Hapus produk test yang dibuat (cleanup DB)
  if (createdProductId) {
    await req(baseUrl, 'DELETE', `/api/products/${createdProductId}`, {
      token: tokenPemilik,
    });
  }

  // Hapus user test sementara langsung via Mongoose
  await User.deleteOne({ username: PEMILIK_TEST_USERNAME });
  await User.deleteOne({ username: KASIR_TEST_USERNAME });

  await stopServer(server);
});
