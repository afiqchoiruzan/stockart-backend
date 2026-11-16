const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const { buildReportHtml, sendReportEmail } = require('../services/emailService');
const { uploadReportToDrive } = require('../services/driveService');

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
    _id: 1
};

const isValidDateKey = (value) => {
    return (
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
    );
};

// "YYYY-MM-DD" -> Date pukul 00:00 WIB pada tanggal tersebut
const toStartOfDayWib = (tanggal, namaField) => {
    if (!isValidDateKey(tanggal)) {
        const error = new Error(
            `Format ${namaField} tidak valid. Gunakan format YYYY-MM-DD`
        );

        error.statusCode = 400;
        throw error;
    }

    return new Date(`${tanggal}T00:00:00${WIB_OFFSET}`);
};

const buildDateFilter = (tanggalMulai, tanggalAkhir) => {
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
        const error = new Error(
            'tanggalMulai tidak boleh lebih besar dari tanggalAkhir'
        );

        error.statusCode = 400;
        throw error;
    }

    return filter;
};

const parseRevenueInterval = (interval) => {
    if (interval === undefined || interval === '') {
        return 'hari';
    }

    if (!REVENUE_INTERVALS.includes(interval)) {
        const error = new Error(
            'Parameter interval tidak valid. Gunakan "hari" atau "jam"'
        );

        error.statusCode = 400;
        throw error;
    }

    return interval;
};

const getSummary = async (req, res) => {
    try {
        const { tanggalMulai, tanggalAkhir } = req.query;

        const dateFilter = buildDateFilter(
            tanggalMulai,
            tanggalAkhir
        );

        const filterTransaksi = {
            status: 'selesai',
            ...(Object.keys(dateFilter).length > 0 && {
                createdAt: dateFilter
            })
        };

        const totalProduk = await Product.countDocuments();

        const totalTransaksi = await Transaction.countDocuments(
            filterTransaksi
        );

        const hasilOmzet = await Transaction.aggregate([
            {
                $match: filterTransaksi
            },
            {
                $group: {
                    _id: null,
                    totalOmzet: {
                        $sum: '$totalHarga'
                    }
                }
            }
        ]);

        const totalOmzet =
            hasilOmzet.length > 0
                ? hasilOmzet[0].totalOmzet
                : 0;

        res.status(200).json({
            success: true,
            data: {
                totalProduk,
                totalTransaksi,
                totalOmzet
            }
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;

        res.status(statusCode).json({
            success: false,
            message:
                statusCode === 400
                    ? error.message
                    : 'Gagal mengambil ringkasan laporan'
        });
    }
};

const getRevenue = async (req, res) => {
    try {
        const { tanggalMulai, tanggalAkhir } = req.query;

        // interval=hari (default) -> omzet per tanggal WIB
        // interval=jam -> omzet per jam WIB (00-23) dalam rentang tanggal
        const interval = parseRevenueInterval(req.query.interval);

        const dateFilter = buildDateFilter(
            tanggalMulai,
            tanggalAkhir
        );

        const filterTransaksi = {
            status: 'selesai',
            ...(Object.keys(dateFilter).length > 0 && {
                createdAt: dateFilter
            })
        };

        const hasil = await Transaction.aggregate([
            {
                $match: filterTransaksi
            },
            {
                $group: {
                    _id: {
                        $dateToString: {
                            format: interval === 'jam' ? '%H' : '%Y-%m-%d',
                            date: '$createdAt',
                            timezone: TIMEZONE
                        }
                    },
                    omzet: {
                        $sum: '$totalHarga'
                    },
                    jumlahTransaksi: {
                        $sum: 1
                    }
                }
            },
            {
                $sort: {
                    _id: 1
                }
            }
        ]);

        const data = hasil.map((item) => ({
            [interval === 'jam' ? 'jam' : 'tanggal']: item._id,
            omzet: item.omzet,
            jumlahTransaksi: item.jumlahTransaksi
        }));

        res.status(200).json({
            success: true,
            data
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;

        res.status(statusCode).json({
            success: false,
            message:
                statusCode === 400
                    ? error.message
                    : 'Gagal mengambil laporan omzet'
        });
    }
};

const getTopProducts = async (req, res) => {
    try {
        const { tanggalMulai, tanggalAkhir } = req.query;

        const dateFilter = buildDateFilter(
            tanggalMulai,
            tanggalAkhir
        );

        const filterTransaksi = {
            status: 'selesai',
            ...(Object.keys(dateFilter).length > 0 && {
                createdAt: dateFilter
            })
        };

        const hasil = await Transaction.aggregate([
            {
                $match: filterTransaksi
            },
            {
                $unwind: '$detailBarang'
            },
            {
                $group: {
                    _id: '$detailBarang.produk',
                    totalTerjual: {
                        $sum: '$detailBarang.jumlah'
                    },
                    totalPendapatan: {
                        $sum: '$detailBarang.subtotal'
                    }
                }
            },
            {
                $sort: TOP_PRODUCTS_SORT
            },
            {
                $limit: 5
            },
            {
                $lookup: {
                    from: 'products',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'produk'
                }
            },
            {
                $unwind: '$produk'
            },
            {
                $project: {
                    _id: 0,
                    produkId: '$_id',
                    namaProduk: '$produk.nama',
                    totalTerjual: 1,
                    totalPendapatan: 1
                }
            }
        ]);

        res.status(200).json({
            success: true,
            data: hasil
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;

        res.status(statusCode).json({
            success: false,
            message:
                statusCode === 400
                    ? error.message
                    : 'Gagal mengambil produk terlaris'
        });
    }
};

const sendReportToOwner = async (req, res) => {
    try {
        const tanggalMulai = req.body?.tanggalMulai || req.query?.tanggalMulai;
        const tanggalAkhir = req.body?.tanggalAkhir || req.query?.tanggalAkhir;
        const customEmail = req.body?.email;

        const dateFilter = buildDateFilter(tanggalMulai, tanggalAkhir);

        const filterTransaksi = {
            status: 'selesai',
            ...(Object.keys(dateFilter).length > 0 && {
                createdAt: dateFilter
            })
        };

        const [totalProduk, totalTransaksi, hasilOmzet, topProducts] = await Promise.all([
            Product.countDocuments({ aktif: true }),
            Transaction.countDocuments(filterTransaksi),
            Transaction.aggregate([
                { $match: filterTransaksi },
                { $group: { _id: null, totalOmzet: { $sum: '$totalHarga' } } }
            ]),
            Transaction.aggregate([
                { $match: filterTransaksi },
                { $unwind: '$detailBarang' },
                {
                    $group: {
                        _id: '$detailBarang.produk',
                        totalTerjual: { $sum: '$detailBarang.jumlah' },
                        totalPendapatan: { $sum: '$detailBarang.subtotal' }
                    }
                },
                { $sort: TOP_PRODUCTS_SORT },
                { $limit: 5 },
                {
                    $lookup: {
                        from: 'products',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'produk'
                    }
                },
                { $unwind: '$produk' },
                {
                    $project: {
                        _id: 0,
                        produkId: '$_id',
                        namaProduk: '$produk.nama',
                        totalTerjual: 1,
                        totalPendapatan: 1
                    }
                }
            ])
        ]);

        const totalOmzet = hasilOmzet.length > 0 ? hasilOmzet[0].totalOmzet : 0;
        const periodeLabel =
            tanggalMulai || tanggalAkhir
                ? `${tanggalMulai || 'Awal'} s/d ${tanggalAkhir || 'Sekarang'}`
                : 'Semua Periode (Hingga Hari Ini)';

        const summary = { totalProduk, totalTransaksi, totalOmzet };
        const htmlContent = buildReportHtml({
            periodeLabel,
            summary,
            topProducts,
            to: customEmail
        });

        let driveInfo = { uploaded: false };
        if (process.env.GDRIVE_WEBHOOK_URL) {
            const safeDate = new Date().toISOString().slice(0, 10);
            driveInfo = await uploadReportToDrive({
                fileName: `Laporan_StockArt_${safeDate}.pdf`,
                content: htmlContent,
                ownerEmail: customEmail || process.env.OWNER_EMAIL
            });
        }

        const emailResult = await sendReportEmail({
            periodeLabel,
            summary,
            topProducts,
            to: customEmail,
            driveInfo
        });

        res.status(200).json({
            success: true,
            message: driveInfo.uploaded
                ? `Laporan berhasil dikirim ke email owner (${emailResult.to}) dan disimpan ke Google Drive`
                : `Laporan berhasil dikirim ke email owner (${emailResult.to})`,
            data: {
                recipient: emailResult.to,
                periode: periodeLabel,
                drive: driveInfo,
                summary,
                topProducts
            }
        });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({
            success: false,
            message:
                statusCode === 400
                    ? error.message
                    : 'Gagal mengirim laporan ke email owner',
            error: error.message
        });
    }
};

module.exports = {
    getSummary,
    getRevenue,
    getTopProducts,
    sendReportToOwner,
    buildDateFilter,
    parseRevenueInterval,
    TOP_PRODUCTS_SORT
};