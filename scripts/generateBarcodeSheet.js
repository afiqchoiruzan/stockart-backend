/**
 * Generator Lembar Barcode — membuat halaman HTML siap cetak berisi barcode produk.
 *
 * Cara pakai:
 *   npm run barcode:sheet
 *
 * Hasil: scripts/output/barcode-sheet.html (buka di browser, lalu Ctrl+P untuk cetak A4).
 *
 * - Mengambil semua produk yang punya `barcode` (isi dulu via `npm run seed:barcodes`).
 * - Barcode 13 digit dengan check digit valid dirender sebagai EAN-13; selain itu CODE128.
 * - Garis hitam di latar putih dengan quiet zone, tanpa warna/efek di area garis.
 * - Produk nonaktif tetap dicetak tetapi diberi label "Nonaktif": kasir akan mendapat
 *   404 saat men-scan produk tersebut.
 *
 * Library: bwip-js (devDependency) — bisa menghasilkan SVG langsung di Node tanpa DOM.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const bwipjs = require('bwip-js');
const connectDB = require('../config/db');
const Product = require('../models/Product');

const OUTPUT_FILE = path.join(__dirname, 'output', 'barcode-sheet.html');

// ─── Fungsi murni ────────────────────────────────────────────────────────────

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);

const formatRupiah = (value) =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
    .format(Number(value) || 0);

const BASE_OPTIONS = {
  scale: 2,
  height: 15, // tinggi garis (mm pada skala 1)
  includetext: true, // EAN-13: tata letak standar (digit pertama di kiri, 2 grup 6 digit)
  textsize: 11,
  paddingwidth: 12, // quiet zone kiri-kanan di dalam SVG
  paddingheight: 4,
  backgroundcolor: 'FFFFFF',
  barcolor: '000000',
  textcolor: '000000',
};

/**
 * Render barcode menjadi SVG. EAN-13 jika 13 digit dan check digit valid
 * (bwip-js memvalidasi sendiri), selain itu CODE128.
 * @returns {{ format: 'EAN-13' | 'CODE128', svg: string }}
 */
const renderBarcodeSvg = (code) => {
  if (/^\d{13}$/.test(code)) {
    try {
      return { format: 'EAN-13', svg: bwipjs.toSVG({ ...BASE_OPTIONS, bcid: 'ean13', text: code }) };
    } catch {
      // Check digit tidak valid → jatuh ke CODE128 agar tetap bisa dicetak dan dibaca.
    }
  }
  return { format: 'CODE128', svg: bwipjs.toSVG({ ...BASE_OPTIONS, bcid: 'code128', text: code }) };
};

const renderCard = (product) => {
  const { format, svg } = renderBarcodeSvg(product.barcode);
  const nonaktif = product.aktif === false
    ? '<span class="badge">Nonaktif</span>'
    : '';
  return `
    <article class="card">
      <h2 class="nama">${escapeHtml(product.nama)}</h2>
      <p class="harga">${escapeHtml(formatRupiah(product.hargaJual))}${nonaktif}</p>
      <div class="barcode" role="img" aria-label="Barcode ${escapeHtml(product.barcode)}">${svg}</div>
      <p class="kode">${escapeHtml(product.barcode)}</p>
      <p class="meta">${escapeHtml(product.kodeProduk)} · ${format}</p>
    </article>`;
};

const renderSheet = (products, generatedAt = new Date()) => {
  const waktu = new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta',
  }).format(generatedAt);

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lembar Barcode StockArt</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    background: #ffffff;
    color: #111111;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header { margin-bottom: 16px; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; font-size: 13px; color: #555555; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 12px;
  }
  .card {
    border: 1px dashed #bbbbbb;
    border-radius: 6px;
    padding: 10px;
    background: #ffffff;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .nama {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.25;
    min-height: 2.5em;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .harga { margin: 2px 0 6px; font-size: 13px; }
  .badge {
    margin-left: 6px;
    padding: 0 6px;
    border: 1px solid #111111;
    border-radius: 4px;
    font-size: 11px;
    text-transform: uppercase;
  }
  /* Area garis: putih polos, quiet zone >= 12px di semua sisi, tanpa efek apa pun. */
  .barcode {
    width: 100%;
    max-width: 240px;
    padding: 12px;
    background: #ffffff;
  }
  .barcode svg { display: block; width: 100%; height: auto; shape-rendering: crispEdges; }
  .kode { margin: 4px 0 0; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 14px; letter-spacing: 1px; }
  .meta { margin: 2px 0 0; font-size: 10px; color: #777777; word-break: break-all; }

  @page { size: A4; margin: 10mm; }
  @media print {
    body { padding: 0; }
    header { margin-bottom: 4mm; }
    header p { font-size: 9pt; }
    /* 3 kolom × 4 baris ≈ 12 kartu per halaman A4 (area cetak 190 × 277 mm). */
    .grid { grid-template-columns: repeat(3, 1fr); gap: 4mm; }
    .card { height: 62mm; padding: 3mm; border-color: #999999; }
    .barcode { max-width: 52mm; padding: 3mm; }
  }
</style>
</head>
<body>
<header>
  <h1>Lembar Barcode StockArt</h1>
  <p>${products.length} produk · dibuat ${escapeHtml(waktu)} WIB · Cetak: Ctrl+P, kertas A4, skala 100%</p>
</header>
<main class="grid">${products.map(renderCard).join('')}
</main>
</body>
</html>
`;
};

// ─── Eksekusi ─────────────────────────────────────────────────────────────────

async function generateBarcodeSheet() {
  await connectDB();

  try {
    // Produk aktif dulu, lalu urut kodeProduk agar mudah dicari di lembar cetak.
    const products = await Product.find(
      { barcode: { $exists: true } },
      { nama: 1, kodeProduk: 1, barcode: 1, hargaJual: 1, aktif: 1 }
    )
      .sort({ aktif: -1, kodeProduk: 1 })
      .lean();

    if (products.length === 0) {
      console.log('Tidak ada produk dengan barcode. Jalankan `npm run seed:barcodes` terlebih dahulu.');
      return;
    }

    const html = renderSheet(products);
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, html);

    const nonaktif = products.filter((p) => p.aktif === false).length;
    const code128 = products.filter((p) => renderBarcodeSvg(p.barcode).format === 'CODE128').length;
    console.log(`✅ ${products.length} kartu barcode ditulis ke ${path.relative(process.cwd(), OUTPUT_FILE)}`);
    console.log(`   EAN-13: ${products.length - code128} | CODE128: ${code128} | nonaktif: ${nonaktif}`);
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB disconnected.');
  }
}

if (require.main === module) {
  generateBarcodeSheet().catch((err) => {
    console.error('Generate lembar barcode gagal:', err.message);
    process.exit(1);
  });
}

module.exports = { renderBarcodeSvg, renderSheet, escapeHtml, formatRupiah };
