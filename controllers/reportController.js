const {
    parseRevenueInterval,
    getReportSummary,
    getRevenueSeries,
    getTopProducts: getTopProductsReport,
    buildReportPdf,
    sendReport
} = require('../services/reportService');
const { validateOptionalEmailRecipients } = require('../services/emailService');
const { getReportScheduleSettings } = require('../services/reportScheduleSettingsService');

const getSummary = async (req, res) => {
    try {
        const { tanggalMulai, tanggalAkhir } = req.query;

        const data = await getReportSummary({
            tanggalMulai,
            tanggalAkhir
        });

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

        const data = await getRevenueSeries(
            { tanggalMulai, tanggalAkhir },
            interval
        );

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
        });

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
        const customEmail = validateOptionalEmailRecipients(req.body?.email).normalized;
        const settings = customEmail ? null : await getReportScheduleSettings();
        const effectiveEmail = customEmail || settings?.recipientEmail || undefined;

        const data = await sendReport({
            tanggalMulai,
            tanggalAkhir,
            email: effectiveEmail
        });

        const targetLabel = effectiveEmail
            ? data.recipient
            : `email owner (${data.recipient})`;

        res.status(200).json({
            success: true,
            message: data.drive.uploaded
                ? `Laporan berhasil dikirim ke ${targetLabel} dan disimpan ke Google Drive`
                : `Laporan berhasil dikirim ke ${targetLabel}`,
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
