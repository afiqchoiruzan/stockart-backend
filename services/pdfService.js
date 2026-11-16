'use strict';

/**
 * Menghasilkan file PDF 1.4 valid secara native (tanpa library eksternal)
 * berisi Laporan Penjualan & Stok Stockart dengan gaya monokrom yang sama
 * seperti email laporan: ringkasan, grafik omzet, dan produk terlaris.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Palet monokrom (sama dengan email laporan & email rekap stok)
const COLORS = {
  black: '#000000',
  text: '#171717',
  body: '#404040',
  muted: '#525252',
  border: '#E5E5E5',
  borderStrong: '#D4D4D4',
  header: '#F5F5F5',
  stripe: '#FAFAFA',
  bar: '#171717',
  barEmpty: '#D4D4D4',
};

const REPORT_FREQUENCY_LABELS = {
  daily: 'Harian',
  weekly: 'Mingguan',
  monthly: 'Bulanan',
};

// Lebar glyph Helvetica (per 1000 unit em) untuk karakter ASCII 32..126,
// dipakai untuk rata kanan, rata tengah, dan memotong teks panjang.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];

function hexToRgb(hex) {
  const value = String(hex).replace('#', '');
  return [0, 2, 4]
    .map((i) => (parseInt(value.slice(i, i + 2), 16) / 255).toFixed(3))
    .join(' ');
}

/**
 * Font standar PDF (WinAnsi) hanya mendukung Latin-1, jadi karakter lain
 * (mis. em dash) diganti padanan ASCII agar tidak rusak saat dicetak.
 */
function sanitizeText(text) {
  return String(text ?? '')
    .replace(/[   ]/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, '');
}

function escapePdfText(text) {
  return sanitizeText(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function textWidth(text, size, bold = false) {
  const clean = sanitizeText(text);
  let units = 0;
  for (const ch of clean) {
    const code = ch.charCodeAt(0);
    const base = code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : 556;
    // Helvetica-Bold sedikit lebih lebar untuk huruf; angka tetap sama
    units += bold && /[A-Za-z]/.test(ch) ? base * 1.06 : base;
  }
  return (units * size) / 1000;
}

function truncateText(text, maxWidth, size, bold = false) {
  const clean = sanitizeText(text);
  if (textWidth(clean, size, bold) <= maxWidth) return clean;
  let result = clean;
  while (result.length > 1 && textWidth(`${result}...`, size, bold) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result.trimEnd()}...`;
}

const formatRp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const formatUnit = (n) => Number(n || 0).toLocaleString('id-ID');

function formatShortRp(n) {
  const value = Number(n || 0);
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace('.', ',')} jt`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} rb`;
  return String(Math.round(value));
}

function formatShortDate(dateKey) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${dateKey}T00:00:00+07:00`));
}

function formatPeriodeLabel(periodeLabel) {
  return String(periodeLabel || '').replace(/\d{4}-\d{2}-\d{2}/g, formatShortDate);
}

function formatWibDateTime(date) {
  return (
    new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(date)) + ' WIB'
  );
}

/**
 * Kanvas sederhana di atas operator PDF. Koordinat `top` diukur dari atas halaman
 * agar tata letak lebih mudah dibaca, lalu dikonversi ke koordinat PDF (dari bawah).
 */
function createCanvas() {
  const ops = [];
  const y = (top) => (PAGE_HEIGHT - top).toFixed(2);

  return {
    ops,
    rect(x, top, w, h, color) {
      ops.push(`${hexToRgb(color)} rg`);
      ops.push(`${x.toFixed(2)} ${y(top + h)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    },
    line(x1, top1, x2, top2, color, width = 0.75) {
      ops.push(`${hexToRgb(color)} RG ${width} w`);
      ops.push(`${x1.toFixed(2)} ${y(top1)} m ${x2.toFixed(2)} ${y(top2)} l S`);
    },
    text(str, x, baselineTop, { size = 10, bold = false, color = COLORS.text, align = 'left' } = {}) {
      const width = textWidth(str, size, bold);
      let left = x;
      if (align === 'right') left = x - width;
      if (align === 'center') left = x - width / 2;
      ops.push(`${hexToRgb(color)} rg`);
      ops.push(
        `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${left.toFixed(2)} ${y(baselineTop)} Td (${escapePdfText(str)}) Tj ET`
      );
    },
  };
}

/**
 * Header tabel bergaya email: latar abu muda + garis bawah hitam tebal.
 */
function drawTableHeader(canvas, top, columns) {
  const height = 22;
  canvas.rect(MARGIN, top, CONTENT_WIDTH, height, COLORS.header);
  canvas.line(MARGIN, top + height, MARGIN + CONTENT_WIDTH, top + height, COLORS.black, 1.5);
  columns.forEach(({ label, x, align, keepCase = false }) => {
    canvas.text(keepCase ? label : label.toUpperCase(), x, top + 14.5, {
      size: 8,
      bold: true,
      color: COLORS.text,
      align,
    });
  });
  return top + height;
}

function drawRowBackground(canvas, top, height, idx) {
  canvas.rect(MARGIN, top, CONTENT_WIDTH, height, idx % 2 === 0 ? '#FFFFFF' : COLORS.stripe);
  canvas.line(MARGIN, top + height, MARGIN + CONTENT_WIDTH, top + height, COLORS.border, 0.5);
}

function drawSummary(canvas, top, summary) {
  const data = summary || {};
  const right = MARGIN + CONTENT_WIDTH - 12;
  let cursor = drawTableHeader(canvas, top, [
    { label: 'Ringkasan', x: MARGIN + 12 },
    { label: 'Nilai', x: right, align: 'right' },
  ]);

  const rows = [
    ['Total Omzet', formatRp(data.totalOmzet)],
    [data.labaEstimasi ? 'Laba Kotor (estimasi)' : 'Laba Kotor', formatRp(data.totalLaba)],
    ['Transaksi Selesai', `${formatUnit(data.totalTransaksi)} struk`],
    ['Produk Terjual', `${formatUnit(data.totalTerjual)} unit`],
    ['Barang Masuk', `${formatUnit(data.totalMasuk)} unit`],
    ['Katalog Aktif', `${formatUnit(data.totalProduk)} produk`],
  ];

  rows.forEach(([label, value], idx) => {
    const rowHeight = 22;
    drawRowBackground(canvas, cursor, rowHeight, idx);
    canvas.text(label, MARGIN + 12, cursor + 14.5, { size: 9, color: COLORS.body });
    canvas.text(value, right, cursor + 14.5, {
      size: idx <= 1 ? 11 : 9.5,
      bold: true,
      color: idx <= 1 ? COLORS.black : COLORS.text,
      align: 'right',
    });
    cursor += rowHeight;
  });

  return cursor;
}

function drawRevenueChart(canvas, top, chart) {
  const points = Array.isArray(chart?.points) ? chart.points : [];
  const total = points.reduce((sum, p) => sum + Number(p.omzet || 0), 0);
  const right = MARGIN + CONTENT_WIDTH - 12;

  let cursor = drawTableHeader(canvas, top, [
    { label: chart?.title || 'Omzet', x: MARGIN + 12 },
    { label: `Total ${formatRp(total)}`, x: right, align: 'right', keepCase: true },
  ]);

  const boxHeight = 178;
  canvas.line(MARGIN, cursor + boxHeight, MARGIN + CONTENT_WIDTH, cursor + boxHeight, COLORS.border, 0.5);

  const maxOmzet = Math.max(0, ...points.map((p) => Number(p.omzet || 0)));
  if (points.length === 0 || maxOmzet <= 0) {
    canvas.text('Belum ada omzet pada periode ini.', MARGIN + CONTENT_WIDTH / 2, cursor + boxHeight / 2 + 3, {
      size: 9,
      color: COLORS.muted,
      align: 'center',
    });
    return cursor + boxHeight;
  }

  const plotLeft = MARGIN + 12;
  const plotWidth = CONTENT_WIDTH - 24;
  const plotTop = cursor + 22;
  const plotHeight = 112;
  const baseline = plotTop + plotHeight;
  const slot = plotWidth / points.length;
  const barWidth = Math.min(36, slot * 0.62);
  const showValues = slot >= 26;
  const labelEvery = slot >= 20 ? 1 : Math.ceil(20 / slot);

  canvas.line(plotLeft, baseline, plotLeft + plotWidth, baseline, COLORS.borderStrong, 0.75);

  points.forEach((point, idx) => {
    const omzet = Number(point.omzet || 0);
    const center = plotLeft + slot * idx + slot / 2;
    const barHeight = omzet > 0 ? Math.max(2, (omzet / maxOmzet) * plotHeight) : 0;

    if (barHeight > 0) {
      canvas.rect(center - barWidth / 2, baseline - barHeight, barWidth, barHeight, COLORS.bar);
      if (showValues || omzet === maxOmzet) {
        canvas.text(formatShortRp(omzet), center, baseline - barHeight - 4, {
          size: 6.5,
          bold: omzet === maxOmzet,
          color: COLORS.muted,
          align: 'center',
        });
      }
    } else {
      canvas.rect(center - barWidth / 2, baseline - 1, barWidth, 1, COLORS.barEmpty);
    }

    if (idx % labelEvery === 0) {
      canvas.text(point.label, center, baseline + 12, { size: 7, color: COLORS.text, align: 'center' });
      if (point.sublabel) {
        canvas.text(point.sublabel, center, baseline + 21, { size: 6.5, color: COLORS.muted, align: 'center' });
      }
    }
  });

  if (chart?.note) {
    canvas.text(chart.note, MARGIN + 12, cursor + boxHeight - 8, { size: 7, color: COLORS.muted });
  }

  return cursor + boxHeight;
}

function drawTopProducts(canvas, top, topProducts) {
  const items = Array.isArray(topProducts) ? topProducts : [];
  const colNo = MARGIN + 20;
  const colName = MARGIN + 44;
  const colSold = MARGIN + 360;
  const colRevenue = MARGIN + CONTENT_WIDTH - 12;

  let cursor = drawTableHeader(canvas, top, [
    { label: 'No', x: colNo, align: 'center' },
    { label: 'Produk Terlaris', x: colName },
    { label: 'Terjual', x: colSold, align: 'center' },
    { label: 'Pendapatan', x: colRevenue, align: 'right' },
  ]);

  if (items.length === 0) {
    const rowHeight = 30;
    drawRowBackground(canvas, cursor, rowHeight, 0);
    canvas.text('Belum ada transaksi selesai pada periode ini.', MARGIN + CONTENT_WIDTH / 2, cursor + 19, {
      size: 9,
      color: COLORS.muted,
      align: 'center',
    });
    return cursor + rowHeight;
  }

  items.forEach((item, idx) => {
    const rowHeight = 24;
    drawRowBackground(canvas, cursor, rowHeight, idx);
    canvas.text(String(idx + 1), colNo, cursor + 15.5, { size: 9, color: COLORS.muted, align: 'center' });
    canvas.text(truncateText(item.namaProduk, colSold - colName - 50, 9.5, true), colName, cursor + 15.5, {
      size: 9.5,
      bold: true,
      color: COLORS.black,
    });
    canvas.text(`${formatUnit(item.totalTerjual)} unit`, colSold, cursor + 15.5, {
      size: 9.5,
      bold: true,
      align: 'center',
    });
    canvas.text(formatRp(item.totalPendapatan), colRevenue, cursor + 15.5, {
      size: 9.5,
      bold: true,
      align: 'right',
    });
    cursor += rowHeight;
  });

  return cursor;
}

/**
 * @param {object} data
 * @param {string} data.periodeLabel   - mis. "2026-11-10 s/d 2026-11-16"
 * @param {object} data.summary        - { totalOmzet, totalTransaksi, totalTerjual, totalMasuk, totalProduk }
 * @param {Array}  data.topProducts    - [{ namaProduk, totalTerjual, totalPendapatan }]
 * @param {object} [data.chart]        - { title, points: [{ label, sublabel?, omzet }], note? }
 * @param {string} [data.context]      - "manual" | "scheduled"
 * @param {string} [data.frequency]    - "daily" | "weekly" | "monthly"
 * @param {Date}   [data.generatedAt]
 * @returns {Buffer} Buffer file PDF
 */
function generateReportPdfBuffer({
  periodeLabel,
  summary,
  topProducts,
  chart,
  context,
  frequency,
  generatedAt = new Date(),
}) {
  const canvas = createCanvas();
  const freqLabel = REPORT_FREQUENCY_LABELS[frequency];
  const title =
    context === 'scheduled' && freqLabel
      ? `Laporan ${freqLabel} Penjualan & Stok`
      : 'Laporan Penjualan & Stok';

  // Header: garis hitam di atas, nama brand, judul, dan periode
  canvas.rect(MARGIN, MARGIN, CONTENT_WIDTH, 4, COLORS.black);
  canvas.text('Stockart', MARGIN, MARGIN + 26, { size: 12, bold: true, color: COLORS.black });
  canvas.text(title, MARGIN, MARGIN + 52, { size: 20, bold: true, color: COLORS.black });
  canvas.text(
    `Periode ${formatPeriodeLabel(periodeLabel)}  |  dibuat ${formatWibDateTime(generatedAt)}`,
    MARGIN,
    MARGIN + 70,
    { size: 9, color: COLORS.muted }
  );
  canvas.line(MARGIN, MARGIN + 84, MARGIN + CONTENT_WIDTH, MARGIN + 84, COLORS.border, 0.75);

  let cursor = MARGIN + 100;
  cursor = drawSummary(canvas, cursor, summary) + 20;
  cursor = drawRevenueChart(canvas, cursor, chart) + 20;
  cursor = drawTopProducts(canvas, cursor, topProducts) + 24;

  canvas.line(MARGIN, cursor, MARGIN + CONTENT_WIDTH, cursor, COLORS.border, 0.75);
  canvas.text(
    `Dicetak otomatis oleh sistem Stockart pada ${formatWibDateTime(generatedAt)}.`,
    MARGIN,
    cursor + 16,
    { size: 8, color: COLORS.muted }
  );

  const contentStream = canvas.ops.join('\n');
  const streamBytes = Buffer.byteLength(contentStream, 'latin1');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n`,
    `4 0 obj\n<< /Length ${streamBytes} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += obj;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = {
  generateReportPdfBuffer,
  sanitizeText,
  textWidth,
};
