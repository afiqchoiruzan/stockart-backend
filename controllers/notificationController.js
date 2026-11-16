'use strict';

const {
  getLowStockSettings,
  updateLowStockSettings,
  formatSettingsResponse,
} = require('../services/lowStockSettingsService');
const {
  getReportScheduleSettings,
  updateReportScheduleSettings,
  formatReportSettingsResponse,
} = require('../services/reportScheduleSettingsService');

// GET /api/notifications/low-stock/settings
exports.getLowStockAlertSettings = async (req, res) => {
  try {
    const settings = await getLowStockSettings();
    res.status(200).json({
      success: true,
      data: formatSettingsResponse(settings),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : 'Gagal mengambil pengaturan jadwal alert low stock',
      ...(error.errors ? { errors: error.errors } : {}),
    });
  }
};

// PUT /api/notifications/low-stock/settings
exports.updateLowStockAlertSettings = async (req, res) => {
  try {
    const updated = await updateLowStockSettings(req.body);
    res.status(200).json({
      success: true,
      message: 'Pengaturan jadwal alert low stock berhasil diperbarui',
      data: formatSettingsResponse(updated),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : 'Gagal memperbarui pengaturan jadwal alert low stock',
      ...(error.errors ? { errors: error.errors } : {}),
    });
  }
};

// GET /api/notifications/report/settings
exports.getReportAutoSendSettings = async (req, res) => {
  try {
    const settings = await getReportScheduleSettings();
    res.status(200).json({
      success: true,
      data: formatReportSettingsResponse(settings),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : 'Gagal mengambil pengaturan kirim laporan otomatis',
      ...(error.errors ? { errors: error.errors } : {}),
    });
  }
};

// PUT /api/notifications/report/settings
exports.updateReportAutoSendSettings = async (req, res) => {
  try {
    const updated = await updateReportScheduleSettings(req.body);
    res.status(200).json({
      success: true,
      message: 'Pengaturan kirim laporan otomatis berhasil diperbarui',
      data: formatReportSettingsResponse(updated),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : 'Gagal memperbarui pengaturan kirim laporan otomatis',
      ...(error.errors ? { errors: error.errors } : {}),
    });
  }
};
