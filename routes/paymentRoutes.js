const express = require('express');
const router = express.Router();

const { createQrisPayment, midtransWebhook } = require('../controllers/paymentController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { validate, transactionRules } = require('../middleware/validate');

// Cashier dan owner dapat membuat pembayaran QRIS (sama seperti checkout tunai)
router.post('/qris', protect, authorize('kasir', 'pemilik'), validate(transactionRules), createQrisPayment);

// Notifikasi dari server Midtrans: TANPA protect, diverifikasi lewat signature_key
router.post('/webhook', midtransWebhook);

module.exports = router;
