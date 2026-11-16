const express = require('express');
const router = express.Router();

const {
  getTransactions,
  getTransactionById,
  getTransactionStatus,
  draftTransaction,
  createTransaction,
  cancelTransaction,
} = require('../controllers/transactionController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { validate, transactionRules } = require('../middleware/validate');

// Owner dan cashier dapat melihat transaksi
router.get('/', protect, getTransactions);
router.get('/:id', protect, getTransactionById);
router.get('/:id/status', protect, getTransactionStatus);

// Cashier dan owner dapat menghitung draft dan membuat transaksi
router.post('/draft', protect, authorize('kasir', 'pemilik'), validate(transactionRules), draftTransaction);
router.post('/checkout', protect, authorize('kasir', 'pemilik'), validate(transactionRules), createTransaction);
router.post('/', protect, authorize('kasir', 'pemilik'), validate(transactionRules), createTransaction);

// Hanya owner yang dapat membatalkan transaksi
router.patch('/:id/void', protect, authorize('pemilik'), cancelTransaction);
router.patch('/:id/cancel', protect, authorize('pemilik'), cancelTransaction);

module.exports = router;
