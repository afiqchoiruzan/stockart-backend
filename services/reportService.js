'use strict';

const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const StockEntry = require('../models/StockEntry');
const { buildReportHtml, sendReportEmail } = require('./emailService');
const { uploadReportToDrive } = require('./driveService');
const { generateReportPdfBuffer } = require('./pdfService');

// Seluruh laporan dihitung dalam zona waktu toko (WIB, UTC+7),
// sama seperti filter tanggal pada riwayat transaksi.
const TIMEZONE = 'Asia/Jakarta';
const WIB_OFFSET = '+07:00';
const SATU_HARI_MS = 24 * 60 * 60 * 1000;

const REVENUE_INTERVALS = ['hari', 'jam'];

// Urutan produk terlaris harus stabil agar halaman laporan dan email
// menampilkan peringkat yang sama saat jumlah terjual seri.
const TOP_PRODUCTS_SORT = {
  totalTerjual: -1,
  totalPendapatan: -1,
  _id: 1,
};

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function isValidDateKey(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

/**
 * "YYYY-MM-DD" -> Date pukul 00:00 WIB pada tanggal tersebut.
 */
function toStartOfDayWib(tanggal, namaField) {
  if (!isValidDateKey(tanggal)) {
    throw fail(400, `Format ${namaField} tidak valid. Gunakan format YYYY-MM-DD`);
  }
  return new Date(`${tanggal}T00:00:00${WIB_OFFSET}`);
}

/**
 * Membangun filter createdAt Mongo untuk rentang tanggal WIB (batas akhir eksklusif).
 */
function buildDateFilter(tanggalMulai, tanggalAkhir) {
  if (!tanggalMulai && !tanggalAkhir) {
    return {};
  }

  const filter = {};

  if (tanggalMulai) {
    filter.$gte = toStartOfDayWib(tanggalMulai, 'tanggalMulai');
  }

  if (tanggalAkhir) {
    // Batas akhir eksklusif: pukul 00:00 WIB hari berikutnya
    const akhir = toStartOfDayWib(tanggalAkhir, 'tanggalAkhir');
    filter.$lt = new Date(akhir.getTime() + SATU_HARI_MS);
  }

  if (tanggalMulai && tanggalAkhir && tanggalMulai > tanggalAkhir) {
    throw fail(400, 'tanggalMulai tidak boleh lebih besar dari tanggalAkhir');
  }

  return filter;
}

function parseRevenueInterval(interval) {
  if (interval === undefined || interval === '') {
    return 'hari';
  }
  if (!REVENUE_INTERVALS.includes(interval)) {
    throw fail(400, 'Parameter interval tidak valid. Gunakan "hari" atau "jam"');
  }
  return interval;
}

function buildCreatedAtFilter(range = {}) {
  const dateFilter = buildDateFilter(range.tanggalMulai, range.tanggalAkhir);
  return Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {};
}

function buildTransactionFilter(range = {}) {
  return { status: 'selesai', ...buildCreatedAtFilter(range) };
}

/**
 * Ringkasan laporan: omzet, jumlah transaksi, produk terjual, dan barang masuk.
 * totalProduk menghitung seluruh produk, atau hanya produk aktif bila activeOnly.
 */
async function getReportSummary(range = {}, { activeOnly = false } = {}) {
  const filterTransaksi = buildTransactionFilter(range);
  const filterMasuk = buildCreatedAtFilter(range);

  const [totalProduk, totalTransaksi, hasilOmzet, hasilTerjual, hasilMasuk] = await Promise.all([
    Product.countDocuments(activeOnly ? { aktif: true } : {}),
    Transaction.countDocuments(filterTransaksi),
    Transaction.aggregate([
      { $match: filterTransaksi },
      { $group: { _id: null, totalOmzet: { $sum: '$totalHarga' } } },
    ]),
    Transaction.aggregate([
      { $match: filterTransaksi },
      { $unwind: '$detailBarang' },
      { $group: { _id: null, totalTerjual: { $sum: '$detailBarang.jumlah' } } },
    ]),
    StockEntry.aggregate([
      { $match: filterMasuk },
      { $group: { _id: null, totalMasuk: { $sum: '$jumlah' } } },
    ]),
  ]);

  return {
    totalProduk,
    totalTransaksi,
    totalOmzet: hasilOmzet.length > 0 ? hasilOmzet[0].totalOmzet : 0,
    totalTerjual: hasilTerjual.length > 0 ? hasilTerjual[0].totalTerjual : 0,
    totalMasuk: hasilMasuk.length > 0 ? hasilMasuk[0].totalMasuk : 0,
  };
}

/**
 * Omzet per tanggal WIB (interval "hari") atau per jam WIB (interval "jam").
 */
async function getRevenueSeries(range = {}, interval = 'hari') {
  const hasil = await Transaction.aggregate([
    { $match: buildTransactionFilter(range) },
    {
      $group: {
        _id: {
          $dateToString: {
            format: interval === 'jam' ? '%H' : '%Y-%m-%d',
            date: '$createdAt',
            timezone: TIMEZONE,
          },
        },
        omzet: { $sum: '$totalHarga' },
        jumlahTransaksi: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return hasil.map((item) => ({
    [interval === 'jam' ? 'jam' : 'tanggal']: item._id,
    omzet: item.omzet,
    jumlahTransaksi: item.jumlahTransaksi,
  }));
}

/**
 * 5 produk terlaris berdasarkan jumlah terjual dalam rentang tanggal.
 */
async function getTopProducts(range = {}) {
  return Transaction.aggregate([
    { $match: buildTransactionFilter(range) },
    { $unwind: '$detailBarang' },
    {
      $group: {
        _id: '$detailBarang.produk',
        totalTerjual: { $sum: '$detailBarang.jumlah' },
        totalPendapatan: { $sum: '$detailBarang.subtotal' },
      },
    },
    { $sort: TOP_PRODUCTS_SORT },
    { $limit: 5 },
    {
      $lookup: {
        from: 'products',
        localField: '_id',
        foreignField: '_id',
        as: 'produk',
      },
    },
    { $unwind: '$produk' },
    {
      $project: {
        _id: 0,
        produkId: '$_id',
        namaProduk: '$produk.nama',
        totalTerjual: 1,
        totalPendapatan: 1,
      },
    },
  ]);
}

function buildPeriodeLabel({ tanggalMulai, tanggalAkhir } = {}) {
  return tanggalMulai || tanggalAkhir
    ? `${tanggalMulai || 'Awal'} s/d ${tanggalAkhir || 'Sekarang'}`
    : 'Semua Periode (Hingga Hari Ini)';
}

const WEEKDAY_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MAX_CHART_DAYS = 31;

/** "YYYY-MM-DD" + n hari -> "YYYY-MM-DD". */
function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startKey, endKey) {
  return Math.round(
    (new Date(`${endKey}T00:00:00Z`) - new Date(`${startKey}T00:00:00Z`)) / SATU_HARI_MS
  );
}

/**
 * Data grafik omzet untuk PDF laporan:
 * - rentang 1 hari  -> omzet per jam WIB (jam pertama s/d terakhir yang ada transaksi)
 * - rentang > 1 hari -> omzet per tanggal WIB, setiap hari tampil (maks. 31 hari terakhir)
 */
async function buildRevenueChart(range = {}) {
  const { tanggalMulai, tanggalAkhir } = range;

  if (tanggalMulai && tanggalAkhir && tanggalMulai === tanggalAkhir) {
    const series = await getRevenueSeries(range, 'jam');
    if (series.length === 0) {
      return { title: 'Omzet per Jam', points: [] };
    }
    const byHour = new Map(series.map((item) => [Number(item.jam), item]));
    const hours = Array.from(byHour.keys());
    const points = [];
    for (let hour = Math.min(...hours); hour <= Math.max(...hours); hour += 1) {
      points.push({
        label: String(hour).padStart(2, '0'),
        omzet: Number(byHour.get(hour)?.omzet || 0),
      });
    }
    return { title: 'Omzet per Jam', points };
  }

  const series = await getRevenueSeries(range, 'hari');
  const byDate = new Map(series.map((item) => [item.tanggal, item]));

  let dateKeys;
  let note;
  if (tanggalMulai && tanggalAkhir) {
    const totalDays = daysBetween(tanggalMulai, tanggalAkhir) + 1;
    const start =
      totalDays > MAX_CHART_DAYS ? shiftDateKey(tanggalAkhir, -(MAX_CHART_DAYS - 1)) : tanggalMulai;
    if (totalDays > MAX_CHART_DAYS) note = `Grafik menampilkan ${MAX_CHART_DAYS} hari terakhir.`;
    dateKeys = Array.from(
      { length: daysBetween(start, tanggalAkhir) + 1 },
      (_, i) => shiftDateKey(start, i)
    );
  } else {
    dateKeys = series.map((item) => item.tanggal).slice(-MAX_CHART_DAYS);
    if (series.length > MAX_CHART_DAYS) note = `Grafik menampilkan ${MAX_CHART_DAYS} hari terakhir.`;
  }

  const isShort = dateKeys.length <= 7;
  const points = dateKeys.map((dateKey) => {
    const day = Number(dateKey.slice(8, 10));
    const month = Number(dateKey.slice(5, 7));
    const weekday = WEEKDAY_SHORT[new Date(`${dateKey}T00:00:00Z`).getUTCDay()];
    return {
      label: isShort ? weekday : String(day),
      sublabel: isShort ? `${day}/${month}` : undefined,
      omzet: Number(byDate.get(dateKey)?.omzet || 0),
    };
  });

  return { title: 'Omzet per Hari', points, note };
}

/**
 * Mengumpulkan seluruh data laporan (ringkasan, produk terlaris, grafik omzet)
 * untuk email, PDF, dan unduhan.
 */
async function buildReportData(range = {}) {
  // Validasi rentang lebih dulu agar kesalahan input langsung ditolak (400)
  buildDateFilter(range.tanggalMulai, range.tanggalAkhir);

  const [summary, topProducts, chart] = await Promise.all([
    getReportSummary(range, { activeOnly: true }),
    getTopProducts(range),
    buildRevenueChart(range),
  ]);

  return {
    periodeLabel: buildPeriodeLabel(range),
    summary,
    topProducts,
    chart,
  };
}

/**
 * Membuat file PDF laporan (sama dengan lampiran email) untuk diunduh dari halaman Laporan.
 */
async function buildReportPdf({ tanggalMulai, tanggalAkhir } = {}) {
  const data = await buildReportData({ tanggalMulai, tanggalAkhir });
  const buffer = generateReportPdfBuffer(data);
  const suffix =
    tanggalMulai || tanggalAkhir
      ? `${tanggalMulai || 'awal'}_${tanggalAkhir || 'sekarang'}`
      : 'semua-periode';
  return { buffer, fileName: `Laporan_Stockart_${suffix}.pdf` };
}

/**
 * Menyusun laporan lalu mengirimkannya ke email owner.
 * Salinan PDF diunggah ke Google Drive bila saveToDrive aktif dan GDRIVE_WEBHOOK_URL diatur.
 * context: "manual" (tombol kirim sekarang) atau "scheduled" (laporan otomatis).
 */
async function sendReport({
  tanggalMulai,
  tanggalAkhir,
  email,
  saveToDrive = true,
  context = 'manual',
  frequency,
} = {}) {
  const { periodeLabel, summary, topProducts, chart } = await buildReportData({
    tanggalMulai,
    tanggalAkhir,
  });

  const htmlContent = buildReportHtml({
    periodeLabel,
    summary,
    topProducts,
    to: email,
    context,
    frequency,
  });

  let driveInfo = { uploaded: false };
  if (saveToDrive && process.env.GDRIVE_WEBHOOK_URL) {
    const safeDate = new Date().toISOString().slice(0, 10);
    driveInfo = await uploadReportToDrive({
      fileName: `Laporan_Stockart_${safeDate}.pdf`,
      content: htmlContent,
      ownerEmail: email || process.env.OWNER_EMAIL,
    });
  }

  const emailResult = await sendReportEmail({
    periodeLabel,
    summary,
    topProducts,
    to: email,
    driveInfo,
    chart,
    context,
    frequency,
  });

  return {
    recipient: emailResult.to,
    periode: periodeLabel,
    drive: driveInfo,
    summary,
    topProducts,
  };
}

module.exports = {
  TIMEZONE,
  TOP_PRODUCTS_SORT,
  buildDateFilter,
  parseRevenueInterval,
  getReportSummary,
  getRevenueSeries,
  getTopProducts,
  buildPeriodeLabel,
  buildRevenueChart,
  buildReportData,
  buildReportPdf,
  sendReport,
};
