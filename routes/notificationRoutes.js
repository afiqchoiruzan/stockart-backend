'use strict';

const express = require('express');
const router = express.Router();

const {
  getLowStockAlertSettings,
  updateLowStockAlertSettings,
  getReportAutoSendSettings,
  updateReportAutoSendSettings,
} = require('../controllers/notificationController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { validate, lowStockSettingsRules, reportSettingsRules } = require('../middleware/validate');

// Hanya pemilik yang dapat melihat dan mengubah pengaturan jadwal alert low stock
router.get('/low-stock/settings', protect, authorize('pemilik'), getLowStockAlertSettings);
router.put(
  '/low-stock/settings',
  protect,
  authorize('pemilik'),
  validate(lowStockSettingsRules),
  updateLowStockAlertSettings
);

// Hanya pemilik yang dapat melihat dan mengubah jadwal kirim laporan otomatis
router.get('/report/settings', protect, authorize('pemilik'), getReportAutoSendSettings);
router.put(
  '/report/settings',
  protect,
  authorize('pemilik'),
  validate(reportSettingsRules),
  updateReportAutoSendSettings
);

module.exports = router;
