const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const { buildReportHtml, sendReportEmail } = require('../services/emailService');
const { uploadReportToDrive } = require('../services/driveService');

const buildDateFilter = (tanggalMulai, tanggalAkhir) => {
    if (!tanggalMulai && !tanggalAkhir) {
        return {};
    }

    const filter = {};

    if (tanggalMulai) {
        const mulai = new Date(tanggalMulai);

        if (isNaN(mulai.getTime())) {
            const error = new Error(
                'Format tanggalMulai tidak valid. Gunakan format YYYY-MM-DD'
            );

            error.statusCode = 400;
            throw error;
        }

        filter.$gte = mulai;
    }

    if (tanggalAkhir) {
        const akhir = new Date(tanggalAkhir);

        if (isNaN(akhir.getTime())) {
            const error = new Error(
                'Format tanggalAkhir tidak valid. Gunakan format YYYY-MM-DD'
            );

            error.statusCode = 400;
            throw error;
        }

        akhir.setHours(23, 59, 59, 999);
        filter.$lte = akhir;
    }

    if (filter.$gte && filter.$lte && filter.$gte > filter.$lte) {
        const error = new Error(
            'tanggalMulai tidak boleh lebih besar dari tanggalAkhir'
        );

        error.statusCode = 400;
        throw error;
    }

    return filter;
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
                            format: '%Y-%m-%d',
                            date: '$createdAt'
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
            tanggal: item._id,
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
                $sort: {
                    totalTerjual: -1
                }
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
                { $sort: { totalTerjual: -1 } },
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
    sendReportToOwner
};