const express = require('express');

const {
    getSummary,
    getRevenue,
    getTopProducts,
    sendReportToOwner,
    downloadReportPdf
} = require('../controllers/reportController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { validate, manualEmailRules } = require('../middleware/validate');

const router = express.Router();

// Hanya pemilik yang dapat mengakses seluruh laporan analitik
router.get('/summary', protect, authorize('pemilik'), getSummary);
router.get('/revenue', protect, authorize('pemilik'), getRevenue);
router.get('/top-products', protect, authorize('pemilik'), getTopProducts);
router.get('/pdf', protect, authorize('pemilik'), downloadReportPdf);
router.post('/send-email', protect, authorize('pemilik'), validate(manualEmailRules), sendReportToOwner);

module.exports = router;