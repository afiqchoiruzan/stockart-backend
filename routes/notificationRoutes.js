'use strict';

const express = require('express');
const router = express.Router();

const {
  getLowStockAlertSettings,
  updateLowStockAlertSettings,
} = require('../controllers/notificationController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { validate, lowStockSettingsRules } = require('../middleware/validate');

// Hanya pemilik yang dapat melihat dan mengubah pengaturan jadwal alert low stock
router.get('/low-stock/settings', protect, authorize('pemilik'), getLowStockAlertSettings);
router.put(
  '/low-stock/settings',
  protect,
  authorize('pemilik'),
  validate(lowStockSettingsRules),
  updateLowStockAlertSettings
);

module.exports = router;
