// Unit test paymentService.createQris — memakai fetch palsu, tanpa jaringan dan tanpa DB.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createQris,
  parseMidtransTime,
  buildOrderId,
  QRIS_EXPIRY_MINUTES,
} = require('../services/paymentService');

const TRX = { _id: '6650a1b2c3d4e5f6a7b8c9d0', totalHarga: 15000 };
const NOW = Date.UTC(2026, 10, 16, 3, 0, 0); // 2026-11-16 10:00:00 WIB

beforeEach(() => {
  process.env.MIDTRANS_SERVER_KEY = 'SB-Mid-server-dummy';
  process.env.MIDTRANS_BASE_URL = 'https://api.sandbox.midtrans.com';
});

// Membuat fetch palsu yang merekam request dan membalas body/status tertentu.
function fakeFetch(body, { status = 200, raw } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = raw !== undefined ? raw : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { impl, calls };
}

const successBody = (overrides = {}) => ({
  status_code: '201',
  status_message: 'QRIS transaction is created',
  transaction_id: 'midtrans-trx-1',
  order_id: buildOrderId(TRX._id, NOW),
  gross_amount: '15000.00',
  transaction_time: '2026-11-16 10:00:00',
  transaction_status: 'pending',
  qr_string: '00020101021226620014COM.GO-JEK.WWW...6304ABCD',
  expiry_time: '2026-11-16 10:15:00',
  actions: [
    { name: 'generate-qr-code', method: 'GET',
      url: 'https://api.sandbox.midtrans.com/v2/qris/midtrans-trx-1/qr-code' },
  ],
  ...overrides,
});

test('createQris: mengirim request charge QRIS yang benar dan memetakan respons', async () => {
  const { impl, calls } = fakeFetch(successBody());
  const result = await createQris(TRX, { fetchImpl: impl, now: NOW });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sandbox.midtrans.com/v2/charge');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization,
    `Basic ${Buffer.from('SB-Mid-server-dummy:').toString('base64')}`);
  assert.deepEqual(calls[0].body, {
    payment_type: 'qris',
    transaction_details: { order_id: `${TRX._id}-${NOW.toString(36)}`, gross_amount: 15000 },
    qris: { acquirer: 'gopay' },
    custom_expiry: { expiry_duration: QRIS_EXPIRY_MINUTES, unit: 'minute' },
  });

  assert.equal(result.qrString, successBody().qr_string);
  assert.equal(result.gatewayRef, `${TRX._id}-${NOW.toString(36)}`);
  assert.equal(result.expiresAt.toISOString(), '2026-11-16T03:15:00.000Z'); // 10:15 WIB
  assert.equal(result.qrImageUrl, successBody().actions[0].url);
  assert.equal(result.gatewayTransactionId, 'midtrans-trx-1');
});

test('createQris: menerima expire_time atau menghitung dari transaction_time jika expiry tidak ada', async () => {
  let { impl } = fakeFetch(successBody({ expiry_time: undefined, expire_time: '2026-11-16 10:20:00' }));
  let result = await createQris(TRX, { fetchImpl: impl, now: NOW });
  assert.equal(result.expiresAt.toISOString(), '2026-11-16T03:20:00.000Z');

  ({ impl } = fakeFetch(successBody({ expiry_time: undefined })));
  result = await createQris(TRX, { fetchImpl: impl, now: NOW });
  assert.equal(result.expiresAt.toISOString(), '2026-11-16T03:15:00.000Z');
});

test('createQris: server key salah (401) menjadi error terkontrol 502', async () => {
  const { impl } = fakeFetch({
    status_code: '401',
    status_message: 'Transaction cannot be authorized with the current client/server key.',
  }, { status: 401 });
  await assert.rejects(createQris(TRX, { fetchImpl: impl, now: NOW }), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.gatewayStatus, '401');
    assert.match(err.message, /Server key Midtrans tidak valid/);
    assert.doesNotMatch(err.message, /SB-Mid-server-dummy/);
    return true;
  });
});

test('createQris: bentuk 401 asli sandbox ({"error":"Unauthorized"} tanpa status_code)', async () => {
  const { impl } = fakeFetch({ error: 'Unauthorized' }, { status: 401 });
  await assert.rejects(createQris(TRX, { fetchImpl: impl, now: NOW }),
    { statusCode: 502, gatewayStatus: '401', gatewayMessage: 'Unauthorized',
      message: /Server key Midtrans tidak valid/ });
});

test('createQris: error di body walau HTTP 200 tetap dianggap gagal (mis. 406 order_id duplikat)', async () => {
  const { impl } = fakeFetch({ status_code: '406', status_message: 'conflict' }, { status: 200 });
  await assert.rejects(createQris(TRX, { fetchImpl: impl, now: NOW }),
    { statusCode: 502, gatewayStatus: '406', message: /Order ID sudah pernah dipakai/ });
});

test('createQris: validation_messages dari Midtrans ikut di pesan error', async () => {
  const { impl } = fakeFetch({ status_code: '400', status_message: 'invalid',
    validation_messages: ['transaction_details.gross_amount is required'] }, { status: 400 });
  await assert.rejects(createQris(TRX, { fetchImpl: impl, now: NOW }),
    { statusCode: 502, message: /gross_amount is required/ });
});

test('createQris: HTTP non-2xx dengan body bukan JSON', async () => {
  const { impl } = fakeFetch(null, { status: 503, raw: '<html>Service Unavailable</html>' });
  await assert.rejects(createQris(TRX, { fetchImpl: impl, now: NOW }),
    { statusCode: 502, message: /tidak dapat dibaca \(HTTP 503\)/ });
});

test('createQris: respons sukses tanpa qr_string ditolak', async () => {
  const { impl } = fakeFetch(successBody({ qr_string: undefined }));
  await assert.rejects(createQris(TRX, { fetchImpl: impl, now: NOW }),
    { statusCode: 502, message: /tidak berisi qr_string/ });
});

test('createQris: gangguan jaringan menjadi 502', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(createQris(TRX, { fetchImpl: impl, now: NOW }),
    { statusCode: 502, message: /Tidak dapat terhubung ke Midtrans/ });
});

test('createQris: timeout menjadi 504 (memakai AbortSignal sungguhan)', async () => {
  // Fetch palsu yang hanya selesai saat signal dibatalkan.
  const impl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  await assert.rejects(createQris(TRX, { fetchImpl: impl, timeoutMs: 50, now: NOW }),
    { statusCode: 504, message: /tidak merespons/ });
});

test('createQris: menolak total tidak valid sebelum memanggil Midtrans', async () => {
  const { impl, calls } = fakeFetch(successBody());
  for (const totalHarga of [0, -1000, 1500.5, NaN, undefined]) {
    await assert.rejects(createQris({ _id: TRX._id, totalHarga }, { fetchImpl: impl }),
      { statusCode: 400 });
  }
  await assert.rejects(createQris({ totalHarga: 1000 }, { fetchImpl: impl }), { statusCode: 400 });
  assert.equal(calls.length, 0);
});

test('createQris: konfigurasi tidak lengkap / non-sandbox ditolak sebelum memanggil Midtrans', async () => {
  const { impl, calls } = fakeFetch(successBody());
  delete process.env.MIDTRANS_SERVER_KEY;
  await assert.rejects(createQris(TRX, { fetchImpl: impl }), { message: /MIDTRANS_SERVER_KEY/ });

  process.env.MIDTRANS_SERVER_KEY = 'SB-Mid-server-dummy';
  process.env.MIDTRANS_BASE_URL = 'https://api.midtrans.com';
  await assert.rejects(createQris(TRX, { fetchImpl: impl }), { message: /sandbox/ });
  assert.equal(calls.length, 0);
});

test('parseMidtransTime: format GMT+7 Midtrans', () => {
  assert.equal(parseMidtransTime('2026-11-16 23:30:00').toISOString(), '2026-11-16T16:30:00.000Z');
  for (const bad of [undefined, '', '2026-11-16T10:00:00Z', 'kemarin', 12345]) {
    assert.equal(parseMidtransTime(bad), null);
  }
});

test('verifyNotificationSignature: SHA512(order_id + status_code + gross_amount + server key)', () => {
  const crypto = require('node:crypto');
  const { verifyNotificationSignature, computeNotificationSignature } = require('../services/paymentService');
  const n = { order_id: 'ORD-1', status_code: '200', gross_amount: '15000.00' };
  const expected = crypto.createHash('sha512').update('ORD-1' + '200' + '15000.00' + 'SB-Mid-server-dummy').digest('hex');
  assert.equal(computeNotificationSignature(n, 'SB-Mid-server-dummy'), expected);

  assert.equal(verifyNotificationSignature({ ...n, signature_key: expected }), true);
  assert.equal(verifyNotificationSignature({ ...n, signature_key: expected.toUpperCase() }), true);
  assert.equal(verifyNotificationSignature({ ...n, gross_amount: '15000', signature_key: expected }), false);
  assert.equal(verifyNotificationSignature({ ...n, signature_key: expected.slice(0, -1) }), false);
  assert.equal(verifyNotificationSignature({ ...n, signature_key: 'x' }), false);
  assert.equal(verifyNotificationSignature({ ...n }), false);
  assert.equal(verifyNotificationSignature({ ...n, gross_amount: 15000, signature_key: expected }), false);
  assert.equal(verifyNotificationSignature(null), false);

  delete process.env.MIDTRANS_SERVER_KEY;
  assert.throws(() => verifyNotificationSignature({ ...n, signature_key: expected }), /MIDTRANS_SERVER_KEY/);
});
