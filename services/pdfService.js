'use strict';

/**
 * Menghasilkan file PDF 1.4 valid secara native (tanpa library eksternal)
 * berisi Laporan Keuangan & Produk Terlaris StockArt POS.
 * Digunakan sebagai fallback jika konversi PDF dari Google Drive belum aktif.
 *
 * @param {object} data
 * @param {string} data.periodeLabel
 * @param {object} data.summary
 * @param {Array}  data.topProducts
 * @returns {Buffer} Buffer file PDF
 */
function generateReportPdfBuffer({ periodeLabel, summary, topProducts }) {
  const formatRp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  const esc = (str) =>
    String(str || '')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');

  const lines = [];
  // Header Banner (Terracotta #D46743 -> RGB 0.83, 0.40, 0.26)
  lines.push('0.831 0.404 0.263 rg');
  lines.push('40 735 515 65 re f');

  // Header Title (White text)
  lines.push('1 1 1 rg');
  lines.push('BT /F2 16 Tf 55 772 Td (LAPORAN KEUANGAN & PENJUALAN - STOCKART POS) Tj ET');
  lines.push(`BT /F1 10 Tf 55 752 Td (Toko Kelontong "Berkah"  |  Periode: ${esc(periodeLabel)}) Tj ET`);

  // KPI Boxes Background (#FFEAD3 -> RGB 1.0, 0.918, 0.827)
  lines.push('1 0.918 0.827 rg');
  lines.push('40 660 165 55 re f');
  lines.push('215 660 165 55 re f');
  lines.push('390 660 165 55 re f');

  // KPI Text (Dark Brown #2A1E17 -> RGB 0.165, 0.118, 0.09)
  lines.push('0.165 0.118 0.09 rg');
  lines.push('BT /F2 9 Tf 50 698 Td (TOTAL OMZET KEUANGAN) Tj ET');
  lines.push(`BT /F2 13 Tf 50 675 Td (${esc(formatRp(summary.totalOmzet))}) Tj ET`);

  lines.push('BT /F2 9 Tf 225 698 Td (TOTAL TRANSAKSI SELESAI) Tj ET');
  lines.push(`BT /F2 13 Tf 225 675 Td (${esc(summary.totalTransaksi)} Struk) Tj ET`);

  lines.push('BT /F2 9 Tf 400 698 Td (TOTAL KATALOG PRODUK) Tj ET');
  lines.push(`BT /F2 13 Tf 400 675 Td (${esc(summary.totalProduk)} Produk Aktif) Tj ET`);

  // Table Section Title
  lines.push('BT /F2 12 Tf 40 630 Td (DAFTAR 5 PRODUK TERLARIS \\(TOP SELLING PRODUCTS\\)) Tj ET');

  // Table Header Bar
  lines.push('0.91 0.608 0.357 rg');
  lines.push('40 598 515 22 re f');
  lines.push('1 1 1 rg');
  lines.push('BT /F2 10 Tf 50 605 Td (No) Tj ET');
  lines.push('BT /F2 10 Tf 90 605 Td (Nama Produk) Tj ET');
  lines.push('BT /F2 10 Tf 340 605 Td (Unit Terjual) Tj ET');
  lines.push('BT /F2 10 Tf 440 605 Td (Total Pendapatan) Tj ET');

  // Table Rows
  lines.push('0.165 0.118 0.09 rg');
  let y = 578;
  const items = Array.isArray(topProducts) ? topProducts : [];
  if (items.length === 0) {
    lines.push(`BT /F1 10 Tf 50 ${y} Td (Belum ada data transaksi penjualan pada periode ini.) Tj ET`);
    y -= 24;
  } else {
    items.forEach((item, idx) => {
      if (idx % 2 === 1) {
        lines.push('0.99 0.96 0.93 rg');
        lines.push(`40 ${y - 6} 515 20 re f`);
        lines.push('0.165 0.118 0.09 rg');
      }
      lines.push(`BT /F1 10 Tf 50 ${y} Td (#${idx + 1}) Tj ET`);
      lines.push(`BT /F2 10 Tf 90 ${y} Td (${esc(item.namaProduk)}) Tj ET`);
      lines.push(`BT /F1 10 Tf 340 ${y} Td (${esc(item.totalTerjual)} unit) Tj ET`);
      lines.push(`BT /F1 10 Tf 440 ${y} Td (${esc(formatRp(item.totalPendapatan))}) Tj ET`);
      y -= 22;
    });
  }

  // Footer
  lines.push('0.45 0.36 0.32 rg');
  const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  lines.push(`BT /F1 9 Tf 40 ${y - 25} Td (Dicetak otomatis oleh sistem StockArt Backend pada ${esc(timestamp)} WIB) Tj ET`);

  const contentStream = lines.join('\n');
  const streamBytes = Buffer.byteLength(contentStream, 'utf8');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${streamBytes} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'utf8');
}

module.exports = {
  generateReportPdfBuffer,
};

