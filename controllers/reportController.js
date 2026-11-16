const {
    parseRevenueInterval,
    getReportSummary,
    getRevenueSeries,
    getTopProducts: getTopProductsReport,
    buildReportPdf,
    sendReport
} = require('../services/reportService');

const getSummary = async (req, res) => {
    try {
        const { tanggalMulai, tanggalAkhir } = req.query;

        const data = await getReportSummary({
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
            data
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

        const data = await getTopProductsReport({
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
            data
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
                fileName: `Laporan_Stockart_${safeDate}.pdf`,
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
            message: data.drive.uploaded
                ? `Laporan berhasil dikirim ke email owner (${data.recipient}) dan disimpan ke Google Drive`
                : `Laporan berhasil dikirim ke email owner (${data.recipient})`,
            data
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

// GET /api/reports/pdf — unduh PDF laporan (sama dengan lampiran email)
const downloadReportPdf = async (req, res) => {
    try {
        const { tanggalMulai, tanggalAkhir } = req.query;

        const { buffer, fileName } = await buildReportPdf({
            tanggalMulai,
            tanggalAkhir
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${fileName}"`
        );
        res.setHeader('Content-Length', buffer.length);
        res.status(200).send(buffer);

    } catch (error) {
        const statusCode = error.statusCode || 500;

        res.status(statusCode).json({
            success: false,
            message:
                statusCode === 400
                    ? error.message
                    : 'Gagal membuat PDF laporan'
        });
    }
};

module.exports = {
    getSummary,
    getRevenue,
    getTopProducts,
    sendReportToOwner,
    downloadReportPdf
};
