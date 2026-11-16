/**
 * Middleware validasi request body.
 *
 * Cara pakai:
 *   const { validate, registerRules, loginRules, ... } = require('./validate');
 *   router.post('/', validate(registerRules), handler);
 *
 * Jika validasi gagal, langsung kembalikan 400 dengan daftar error.
 * Jika lolos, panggil next().
 */

'use strict';

const { validateSettingsPayload } = require('../services/lowStockSettingsService');
const { validateReportSettingsPayload } = require('../services/reportScheduleSettingsService');
const { validateOptionalEmailRecipients } = require('../services/emailService');

// ─── Helpers internal ────────────────────────────────────────────────────────

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPositiveNumber = (v) => typeof v === 'number' && isFinite(v) && v >= 0;

// Barcode boleh tidak dikirim, null, atau string kosong (berarti "tanpa barcode").
// Jika berisi, harus teks 4–48 karakter tanpa spasi.
const isEmptyBarcode = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const barcodeError = (v) =>
  !isEmptyBarcode(v) && (typeof v !== 'string' || !/^\S{4,48}$/.test(v.trim()))
    ? 'barcode harus berupa teks 4–48 karakter tanpa spasi'
    : null;

// ─── Aturan validasi per endpoint ────────────────────────────────────────────

/**
 * POST /api/auth/register
 * { nama, username, password }
 */
const registerRules = (body) => {
  const errors = [];

  if (!isNonEmptyString(body.nama)) {
    errors.push('nama wajib diisi dan tidak boleh kosong');
  }

  if (!isNonEmptyString(body.username)) {
    errors.push('username wajib diisi dan tidak boleh kosong');
  } else if (!/^[a-zA-Z0-9_]{3,30}$/.test(body.username.trim())) {
    errors.push('username harus 3–30 karakter dan hanya boleh huruf, angka, atau underscore');
  }

  if (!isNonEmptyString(body.password)) {
    errors.push('password wajib diisi dan tidak boleh kosong');
  } else if (body.password.length < 8) {
    errors.push('password minimal 8 karakter');
  }

  return errors;
};

/**
 * POST /api/auth/login
 * { username, password }
 */
const loginRules = (body) => {
  const errors = [];

  if (!isNonEmptyString(body.username)) {
    errors.push('username wajib diisi');
  }

  if (!isNonEmptyString(body.password)) {
    errors.push('password wajib diisi');
  }

  return errors;
};

/**
 * POST /api/products
 * { nama, kodeProduk?, barcode?, hargaBeli, hargaJual, stok?, stokMinimum? }
 * kodeProduk dibuat otomatis jika tidak dikirim.
 */
const productRules = (body) => {
  const errors = [];

  if (!isNonEmptyString(body.nama)) {
    errors.push('nama produk wajib diisi');
  }

  if (body.kodeProduk !== undefined && !isNonEmptyString(body.kodeProduk)) {
    errors.push('kodeProduk harus berupa teks dan tidak boleh kosong jika dikirim');
  }

  const barcodeMsg = barcodeError(body.barcode);
  if (barcodeMsg) errors.push(barcodeMsg);

  if (body.hargaBeli === undefined || body.hargaBeli === null) {
    errors.push('hargaBeli wajib diisi');
  } else if (!isPositiveNumber(Number(body.hargaBeli))) {
    errors.push('hargaBeli harus berupa angka dan tidak boleh negatif');
  }

  if (body.hargaJual === undefined || body.hargaJual === null) {
    errors.push('hargaJual wajib diisi');
  } else if (!isPositiveNumber(Number(body.hargaJual))) {
    errors.push('hargaJual harus berupa angka dan tidak boleh negatif');
  }

  if (body.stok !== undefined && !isPositiveNumber(Number(body.stok))) {
    errors.push('stok harus berupa angka dan tidak boleh negatif');
  }

  if (body.stokMinimum !== undefined && !isPositiveNumber(Number(body.stokMinimum))) {
    errors.push('stokMinimum harus berupa angka dan tidak boleh negatif');
  }

  return errors;
};

/**
 * PUT /api/products/:id  — field bersifat opsional, hanya validasi jika ada
 */
const productUpdateRules = (body) => {
  const errors = [];

  // barcode "" / null pada update berarti hapus barcode (ditangani di controller).
  const barcodeMsg = barcodeError(body.barcode);
  if (barcodeMsg) errors.push(barcodeMsg);

  if (body.hargaBeli !== undefined && !isPositiveNumber(Number(body.hargaBeli))) {
    errors.push('hargaBeli harus berupa angka dan tidak boleh negatif');
  }

  if (body.hargaJual !== undefined && !isPositiveNumber(Number(body.hargaJual))) {
    errors.push('hargaJual harus berupa angka dan tidak boleh negatif');
  }

  if (body.stok !== undefined && !isPositiveNumber(Number(body.stok))) {
    errors.push('stok harus berupa angka dan tidak boleh negatif');
  }

  if (body.stokMinimum !== undefined && !isPositiveNumber(Number(body.stokMinimum))) {
    errors.push('stokMinimum harus berupa angka dan tidak boleh negatif');
  }

  return errors;
};

/**
 * POST /api/transactions
 * POST /api/transactions/draft
 * { detailBarang: [{ produk, jumlah }] }
 */
const transactionRules = (body) => {
  const errors = [];

  if (!Array.isArray(body.detailBarang) || body.detailBarang.length === 0) {
    errors.push('detailBarang wajib diisi dan minimal berisi 1 produk');
    return errors; // tidak perlu lanjut cek item
  }

  body.detailBarang.forEach((item, index) => {
    const prefix = `detailBarang[${index}]`;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${prefix} harus berupa objek`);
      return;
    }

    if (typeof item.produk !== 'string' || !/^[a-fA-F0-9]{24}$/.test(item.produk)) {
      errors.push(`${prefix}.produk harus berupa ObjectId valid`);
    }

    const jumlah = Number(item.jumlah);
    if (!['number', 'string'].includes(typeof item.jumlah) || !Number.isSafeInteger(jumlah) || jumlah < 1) {
      errors.push(`${prefix}.jumlah harus berupa bilangan bulat minimal 1`);
    }
  });

  return errors;
};

/**
 * PATCH /api/products/:id/restock
 * { jumlah }
 */
const restockRules = (body) => {
  const errors = [];

  if (body.jumlah === undefined || body.jumlah === null) {
    errors.push('jumlah wajib diisi');
  } else if (!isPositiveNumber(Number(body.jumlah)) || Number(body.jumlah) === 0) {
    errors.push('jumlah harus berupa angka positif dan lebih dari 0');
  }

  return errors;
};

/**
 * PUT /api/notifications/low-stock/settings
 * { digestFrequency?, digestTime?, digestWeekday?, digestDayOfMonth?, criticalAlertEnabled? }
 */
const lowStockSettingsRules = (body) => validateSettingsPayload(body).errors;

/**
 * PUT /api/notifications/report/settings
 * { digestFrequency?, digestTime?, digestWeekday?, digestDayOfMonth?, saveToDrive? }
 */
const reportSettingsRules = (body) => validateReportSettingsPayload(body).errors;

/**
 * POST /api/products/low-stock/notify & POST /api/reports/send-email
 * { email? } — opsional; jika dikirim, harus format email valid
 */
const manualEmailRules = (body) => {
  const result = validateOptionalEmailRecipients(body?.email);
  return result.valid ? [] : [result.message];
};

// ─── Middleware pabrik ────────────────────────────────────────────────────────

/**
 * Bungkus fungsi aturan validasi menjadi Express middleware.
 *
 * @param {(body: object) => string[]} rulesFn - Fungsi yang menerima req.body
 *   dan mengembalikan array string error. Array kosong berarti lolos validasi.
 * @returns {import('express').RequestHandler}
 */
const validate = (rulesFn) => (req, res, next) => {
  const errors = rulesFn(req.body || {});

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Validasi gagal',
      errors,
    });
  }

  next();
};

module.exports = {
  validate,
  registerRules,
  loginRules,
  productRules,
  productUpdateRules,
  transactionRules,
  restockRules,
  lowStockSettingsRules,
  reportSettingsRules,
  manualEmailRules,
};
