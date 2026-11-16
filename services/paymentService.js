/**
 * Payment Service — integrasi Midtrans Core API (SANDBOX) untuk QRIS dinamis.
 *
 * createQris(transaction) membuat charge QRIS dan mengembalikan data QR.
 * Fungsi ini TIDAK menyentuh database; penyimpanan ke Transaction dilakukan pemanggil.
 *
 * Semua error dilempar dengan `statusCode` (pola sama dengan transactionService.fail):
 *   400 data transaksi tidak valid untuk QRIS
 *   500 konfigurasi Midtrans belum benar (dari config/midtrans.js)
 *   502 Midtrans menolak / respons tidak sesuai / tidak dapat dihubungi
 *   504 Midtrans tidak merespons sebelum timeout
 * Error dari Midtrans membawa `gatewayStatus` (status_code Midtrans) untuk logging.
 */

'use strict';

const crypto = require('node:crypto');
const { getMidtransConfig } = require('../config/midtrans');

// Masa berlaku QR. Diset eksplisit karena default QRIS tidak didokumentasikan Midtrans.
const QRIS_EXPIRY_MINUTES = 15;
const DEFAULT_TIMEOUT_MS = 15000;
const QRIS_ACQUIRER = 'gopay';

const fail = (statusCode, message, extra = {}) =>
  Object.assign(new Error(message), { statusCode, ...extra });

// Pesan ramah untuk status_code Midtrans yang umum pada charge.
const GATEWAY_MESSAGES = {
  400: 'Data pembayaran ditolak Midtrans (parameter tidak valid)',
  401: 'Server key Midtrans tidak valid atau tidak cocok dengan lingkungan sandbox',
  402: 'Metode pembayaran QRIS belum aktif untuk akun Midtrans ini',
  406: 'Order ID sudah pernah dipakai di Midtrans',
  429: 'Terlalu banyak permintaan ke Midtrans, coba lagi sebentar',
};

/**
 * Midtrans memakai format "YYYY-MM-DD HH:MM:SS" dalam GMT+7 tanpa info zona.
 * @returns {Date|null}
 */
function parseMidtransTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** order_id unik per percobaan charge, agar QR bisa dibuat ulang untuk transaksi yang sama. */
function buildOrderId(transactionId, now = Date.now()) {
  return `${transactionId}-${now.toString(36)}`;
}

function buildChargeBody(orderId, grossAmount) {
  return {
    payment_type: 'qris',
    transaction_details: { order_id: orderId, gross_amount: grossAmount },
    qris: { acquirer: QRIS_ACQUIRER },
    custom_expiry: { expiry_duration: QRIS_EXPIRY_MINUTES, unit: 'minute' },
  };
}

async function postCharge(url, headers, body, { fetchImpl, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw fail(504, `Midtrans tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik`);
    }
    throw fail(502, 'Tidak dapat terhubung ke Midtrans. Periksa koneksi internet server', {
      cause: error,
    });
  }

  const text = await response.text().catch(() => '');
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') {
    throw fail(502, `Respons Midtrans tidak dapat dibaca (HTTP ${response.status})`, {
      gatewayStatus: String(response.status),
    });
  }
  return { response, data };
}

/**
 * Membuat charge QRIS di Midtrans untuk sebuah transaksi.
 *
 * @param {{ _id: any, totalHarga: number }} transaction
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, now?: number }} [options]
 *   Opsi untuk tes (fetch palsu, timeout, waktu tetap).
 * @returns {Promise<{ qrString: string, expiresAt: Date, gatewayRef: string,
 *   qrImageUrl: string|null, gatewayTransactionId: string|null }>}
 */
async function createQris(transaction, options = {}) {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now() } = options;

  const transactionId = transaction?._id ? String(transaction._id) : '';
  if (!transactionId) throw fail(400, 'Transaksi tidak memiliki ID');
  const grossAmount = Number(transaction.totalHarga);
  if (!Number.isSafeInteger(grossAmount) || grossAmount < 1) {
    throw fail(400, 'Total transaksi untuk QRIS harus bilangan bulat rupiah minimal 1');
  }

  const { baseUrl, authHeader } = getMidtransConfig();
  const gatewayRef = buildOrderId(transactionId, now);

  const { response, data } = await postCharge(
    `${baseUrl}/v2/charge`,
    { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authHeader },
    buildChargeBody(gatewayRef, grossAmount),
    { fetchImpl, timeoutMs }
  );

  // Status sebenarnya ada di body.status_code; sukses charge QRIS = "201".
  const gatewayStatus = String(data.status_code ?? response.status);
  if (!response.ok || gatewayStatus !== '201') {
    const detail = Array.isArray(data.validation_messages) ? data.validation_messages.join('; ') : '';
    const base = GATEWAY_MESSAGES[gatewayStatus] || 'Midtrans menolak pembuatan QRIS';
    // Sandbox membalas key salah dengan HTTP 401 + {"error":"Unauthorized"} (tanpa status_code).
    const midtransMessage = data.status_message || data.message || data.error || '';
    throw fail(502, `${base} (kode ${gatewayStatus})${detail ? `: ${detail}` : ''}`, {
      gatewayStatus,
      gatewayMessage: midtransMessage,
    });
  }

  if (typeof data.qr_string !== 'string' || !data.qr_string) {
    throw fail(502, 'Respons Midtrans tidak berisi qr_string', { gatewayStatus });
  }

  // Docs Midtrans tidak konsisten: "expiry_time" vs "expire_time".
  let expiresAt = parseMidtransTime(data.expiry_time) || parseMidtransTime(data.expire_time);
  if (!expiresAt) {
    const start = parseMidtransTime(data.transaction_time)?.getTime() ?? now;
    expiresAt = new Date(start + QRIS_EXPIRY_MINUTES * 60 * 1000);
  }

  const qrAction = Array.isArray(data.actions)
    ? data.actions.find((action) => action?.name === 'generate-qr-code')
    : null;

  return {
    qrString: data.qr_string,
    expiresAt,
    gatewayRef: data.order_id || gatewayRef,
    // URL gambar QR; dibutuhkan simulator sandbox (simulator.sandbox.midtrans.com/v2/qris/index).
    qrImageUrl: qrAction?.url || null,
    gatewayTransactionId: data.transaction_id || null,
  };
}

/**
 * signature_key = SHA512(order_id + status_code + gross_amount + KEY), hex.
 * KEY = Signature Secret Key (MIDTRANS_SIGNATURE_KEY), fallback ke Server Key.
 * gross_amount dipakai persis seperti string kiriman Midtrans (mis. "15000.00").
 */
function computeNotificationSignature({ order_id, status_code, gross_amount }, key) {
  return crypto.createHash('sha512')
    .update(`${order_id}${status_code}${gross_amount}${key}`)
    .digest('hex');
}

/**
 * true hanya jika signature_key cocok. Field yang hilang / bukan string -> false.
 * Melempar error konfigurasi (500) jika MIDTRANS_SERVER_KEY belum diatur.
 */
function verifyNotificationSignature(notification) {
  const { signatureKey } = getMidtransConfig();
  const n = notification || {};
  const fields = [n.order_id, n.status_code, n.gross_amount, n.signature_key];
  if (!fields.every((value) => typeof value === 'string' && value.length > 0)) return false;

  const expected = Buffer.from(computeNotificationSignature(n, signatureKey), 'utf8');
  const received = Buffer.from(n.signature_key.toLowerCase(), 'utf8');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

module.exports = {
  createQris,
  computeNotificationSignature,
  verifyNotificationSignature,
  parseMidtransTime,
  buildOrderId,
  buildChargeBody,
  QRIS_EXPIRY_MINUTES,
};
