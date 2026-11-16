/**
 * Seed Script — Mengisi barcode EAN-13 dummy untuk produk yang belum punya barcode.
 *
 * Cara pakai:
 *   npm run seed:barcodes                 # isi produk yang belum punya barcode
 *   npm run seed:barcodes -- --dry-run    # tampilkan rencana saja, DB tidak diubah
 *   npm run seed:barcodes -- --force      # tulis ulang semua barcode dummy ("200...")
 *
 * Format barcode: "200" + 9 digit nomor urut + 1 check digit EAN-13.
 * Prefix 200–299 adalah nomor "restricted circulation" (khusus internal toko),
 * jadi tidak bentrok dengan barcode pabrik asli.
 *
 * Sifat script:
 *   - Idempoten: produk yang sudah punya barcode dilewati.
 *   - Nomor urut dilanjutkan dari barcode dummy tertinggi yang sudah ada di DB.
 *   - --force hanya menimpa barcode dummy; barcode lain (mis. barcode pabrik) tidak disentuh.
 *   - Error duplikat per produk dicatat dan dilewati tanpa menghentikan proses.
 *   - Selesai menulis, daftar barcode disimpan ke scripts/output/barcodes.csv
 *     (kodeProduk, nama, barcode) untuk dicetak sebagai barcode uji.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Product = require('../models/Product');

const DUMMY_PREFIX = '200';
const DUMMY_PATTERN = /^200\d{10}$/;
const SEQUENCE_DIGITS = 9;
const MAX_SEQUENCE = 10 ** SEQUENCE_DIGITS - 1;
const OUTPUT_FILE = path.join(__dirname, 'output', 'barcodes.csv');

// ─── Fungsi murni (diuji di test/seedBarcodes.test.js) ───────────────────────

/**
 * Hitung check digit EAN-13 dari 12 digit pertama.
 * Bobot 1 dan 3 bergantian dari kiri; check = (10 - (jumlah % 10)) % 10.
 */
const ean13CheckDigit = (first12) => {
  if (typeof first12 !== 'string' || !/^\d{12}$/.test(first12)) {
    throw new Error('Input check digit EAN-13 harus 12 digit angka');
  }
  const sum = [...first12].reduce(
    (acc, digit, index) => acc + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0
  );
  return (10 - (sum % 10)) % 10;
};

/** true jika kode adalah EAN-13 13 digit dengan check digit benar. */
const isValidEan13 = (code) =>
  typeof code === 'string' &&
  /^\d{13}$/.test(code) &&
  ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);

/** Barcode dummy dibuat oleh script ini: "200" + 10 digit dengan check digit valid. */
const isDummyBarcode = (code) => DUMMY_PATTERN.test(code || '') && isValidEan13(code);

/** Nomor urut 1 → "2000000000015" (200 + 000000001 + check digit). */
const buildDummyBarcode = (sequence) => {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) {
    throw new Error(`Nomor urut barcode harus 1–${MAX_SEQUENCE}`);
  }
  const first12 = DUMMY_PREFIX + String(sequence).padStart(SEQUENCE_DIGITS, '0');
  return first12 + ean13CheckDigit(first12);
};

/** "2000000000015" → 1 */
const sequenceOf = (dummyBarcode) => Number(dummyBarcode.slice(3, 12));

/**
 * Susun rencana pengisian barcode.
 *
 * @param {Array<{_id, kodeProduk, nama, barcode?}>} products - seluruh produk (urutan dipertahankan)
 * @param {{ force?: boolean }} options
 * @returns {{ plan: Array<{product, oldBarcode, barcode}>, skipped: number, startSequence: number }}
 */
const planBarcodes = (products, { force = false } = {}) => {
  const isTarget = (p) => !p.barcode || (force && isDummyBarcode(p.barcode));
  const targets = products.filter(isTarget);

  // Lanjutkan dari nomor dummy tertinggi milik produk yang TIDAK akan ditimpa.
  const maxSequence = products
    .filter((p) => !isTarget(p) && isDummyBarcode(p.barcode))
    .reduce((max, p) => Math.max(max, sequenceOf(p.barcode)), 0);

  const plan = targets.map((product, index) => ({
    product,
    oldBarcode: product.barcode || null,
    barcode: buildDummyBarcode(maxSequence + index + 1),
  }));

  return { plan, skipped: products.length - targets.length, startSequence: maxSequence + 1 };
};

const csvField = (value) => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** CSV dengan header kodeProduk,nama,barcode — satu baris per produk. */
const toCsv = (products) =>
  ['kodeProduk,nama,barcode']
    .concat(products.map((p) => [p.kodeProduk, p.nama, p.barcode].map(csvField).join(',')))
    .join('\n') + '\n';

// ─── Eksekusi ─────────────────────────────────────────────────────────────────

const isDuplicateKeyError = (error) =>
  error?.code === 11000 || /E11000/i.test(error?.message || '');

async function seedBarcodes({ dryRun = false, force = false } = {}) {
  await connectDB();

  try {
    const fetchProducts = () =>
      Product.find({}, { kodeProduk: 1, nama: 1, barcode: 1 })
        .sort({ createdAt: 1, _id: 1 })
        .lean();

    const products = await fetchProducts();
    const { plan, skipped, startSequence } = planBarcodes(products, { force });

    console.log(
      `Mode: ${dryRun ? 'DRY RUN (tidak menulis ke DB)' : 'TULIS'}${force ? ' + FORCE' : ''}`
    );
    console.log(
      `Total produk: ${products.length} | akan diisi: ${plan.length} | dilewati (sudah punya barcode): ${skipped}`
    );

    if (plan.length === 0) {
      console.log('Tidak ada perubahan.');
    } else {
      console.log(`Nomor urut dimulai dari ${startSequence}.`);
      for (const item of plan) {
        const change = item.oldBarcode ? `${item.oldBarcode} -> ${item.barcode}` : item.barcode;
        console.log(`  ${item.product.kodeProduk.padEnd(42)} ${change}  ${item.product.nama}`);
      }
    }

    if (dryRun) {
      console.log('Dry run selesai. DB dan barcodes.csv tidak diubah.');
      return;
    }

    if (force) {
      // Lepas dulu barcode dummy lama agar penomoran ulang tidak bentrok dengan
      // produk lain yang belum diproses (index unik).
      const forcedIds = plan.filter((item) => item.oldBarcode).map((item) => item.product._id);
      if (forcedIds.length) {
        await Product.updateMany(
          { _id: { $in: forcedIds }, barcode: DUMMY_PATTERN },
          { $unset: { barcode: 1 } }
        );
      }
    }

    let updated = 0;
    const failed = [];
    for (const item of plan) {
      try {
        // Filter barcode $exists:false menjaga agar tidak menimpa barcode yang
        // diisi proses lain sejak data dibaca.
        const result = await Product.updateOne(
          { _id: item.product._id, barcode: { $exists: false } },
          { $set: { barcode: item.barcode } }
        );
        if (result.modifiedCount === 1) {
          updated += 1;
        } else {
          failed.push({ item, reason: 'produk sudah punya barcode atau sudah dihapus' });
        }
      } catch (error) {
        failed.push({
          item,
          reason: isDuplicateKeyError(error) ? 'barcode sudah dipakai produk lain' : error.message,
        });
      }
    }

    console.log(`✅ ${updated} produk berhasil diisi barcode.`);
    if (failed.length) {
      console.log(`⚠️  ${failed.length} produk gagal (jalankan ulang script untuk mencoba lagi):`);
      for (const { item, reason } of failed) {
        console.log(`  ${item.product.kodeProduk} (${item.barcode}): ${reason}`);
      }
    }

    const finalProducts = await fetchProducts();
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, toCsv(finalProducts));
    console.log(
      `📄 ${finalProducts.length} baris ditulis ke ${path.relative(process.cwd(), OUTPUT_FILE)}`
    );
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB disconnected.');
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !['--dry-run', '--force'].includes(arg));
  if (unknown.length) {
    console.error(`Opsi tidak dikenal: ${unknown.join(', ')}. Gunakan --dry-run dan/atau --force.`);
    process.exit(1);
  }

  seedBarcodes({ dryRun: args.includes('--dry-run'), force: args.includes('--force') }).catch(
    (err) => {
      console.error('Seed barcode gagal:', err.message);
      process.exit(1);
    }
  );
}

module.exports = {
  ean13CheckDigit,
  isValidEan13,
  isDummyBarcode,
  buildDummyBarcode,
  planBarcodes,
  toCsv,
};
