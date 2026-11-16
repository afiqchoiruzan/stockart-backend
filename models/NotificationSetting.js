'use strict';

const mongoose = require('mongoose');
const { VALID_FREQUENCIES } = require('../services/lowStockSchedule');

const notificationSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'lowStockAlert',
      trim: true,
    },
    digestFrequency: {
      type: String,
      enum: VALID_FREQUENCIES,
      default: 'weekly',
    },
    digestTime: {
      type: String,
      default: '07:00',
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Format digestTime harus HH:mm'],
    },
    digestWeekday: {
      type: Number,
      min: 0,
      max: 6,
      default: 1, // Senin
    },
    digestDayOfMonth: {
      type: Number,
      min: 1,
      max: 28,
      default: 1,
    },
    criticalAlertEnabled: {
      type: Boolean,
      default: true,
    },
    // Khusus pengaturan key "reportAutoSend": simpan salinan laporan ke Google Drive
    saveToDrive: {
      type: Boolean,
      default: true,
    },
    scheduleActivatedAt: {
      type: Date,
      default: Date.now,
    },
    lastDigestOccurrence: {
      type: Date,
      default: null,
    },
    lastDigestSentAt: {
      type: Date,
      default: null,
    },
    lastDigestStatus: {
      type: String,
      enum: ['sent', 'skipped_empty', 'failed', 'email_not_configured', null],
      default: null,
    },
    lastDigestCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    lastDigestError: {
      type: String,
      default: null,
    },
    digestAttempts: {
      type: Number,
      min: 0,
      default: 0,
    },
    lastAttemptOccurrence: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('NotificationSetting', notificationSettingSchema);
