const express = require('express');
const router = express.Router();

const {
  getProducts,
  getLowStockProducts,
  notifyLowStockProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  restockProduct,
  restoreProduct,
} = require('../controllers/productController');

const { protect, authorize } = require('../middleware/authMiddleware');
const { validate, productRules, productUpdateRules, restockRules } = require('../middleware/validate');

// Owner dan cashier dapat melihat produk
router.get('/', protect, getProducts);
router.get('/low-stock', protect, getLowStockProducts);
router.post('/low-stock/notify', protect, authorize('pemilik'), notifyLowStockProducts);
router.get('/:id', protect, getProductById);

// Hanya owner yang dapat mengelola produk
router.post('/', protect, authorize('pemilik'), validate(productRules), createProduct);
router.put('/:id', protect, authorize('pemilik'), validate(productUpdateRules), updateProduct);
router.patch('/:id/restock', protect, authorize('pemilik'), validate(restockRules), restockProduct);
router.patch('/:id/restore', protect, authorize('pemilik'), restoreProduct);
router.delete('/:id', protect, authorize('pemilik'), deleteProduct);

module.exports = router;