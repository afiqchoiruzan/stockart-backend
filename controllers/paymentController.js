const service = require('../services/transactionService');
const { verifyNotificationSignature } = require('../services/paymentService');
const { isEmailConfigured } = require('../services/emailService');
const { triggerCriticalOutOfStockAlerts } = require('../services/lowStockAlertService');

function sendError(res, error) {
  const status = error.statusCode || 500;
  // 500 = bug atau konfigurasi (mis. MIDTRANS_SERVER_KEY kosong): catat di server, sembunyikan dari klien.
  if (status === 500) console.error('[Payment]', error.message);
  return res.status(status).json({ success: false,
    message: status === 500 ? 'Gagal memproses pembayaran' : error.message });
}

// POST /api/payments/qris — buat transaksi pending + QR Midtrans. Stok belum dipotong.
exports.createQrisPayment = async (req, res) => {
  try {
    const { transaction, qrImageUrl } = await service.createQrisTransaction(
      req.body.detailBarang, req.user._id
    );
    res.status(201).json({
      success: true,
      message: 'QRIS berhasil dibuat, menunggu pembayaran',
      data: { ...transaction.toObject(), qrImageUrl },
    });
  } catch (error) { sendError(res, error); }
};

const WEBHOOK_MESSAGES = {
  paid: 'Pembayaran diterima',
  paid_with_note: 'Pembayaran diterima dengan catatan',
  duplicate: 'Notifikasi sudah diproses sebelumnya',
  expired: 'Pembayaran kedaluwarsa',
  failed: 'Pembayaran gagal',
  ignored: 'Notifikasi diterima tanpa perubahan',
};

// POST /api/payments/webhook — dipanggil server Midtrans, TANPA login.
// Keamanan berasal dari signature_key; hanya endpoint ini yang boleh mengubah status menjadi paid.
exports.midtransWebhook = async (req, res) => {
  try {
    const notification = req.body || {};
    if (!verifyNotificationSignature(notification)) {
      console.warn(`[Midtrans] signature tidak valid untuk order_id=${notification.order_id}`);
      return res.status(401).json({ success: false, message: 'Signature tidak valid' });
    }

    const { result, transaction } = await service.handleMidtransNotification(notification);
    console.log(`[Midtrans] order_id=${notification.order_id} ` +
      `status=${notification.transaction_status} -> ${result}`);
    res.json({ success: true, message: WEBHOOK_MESSAGES[result], data: { result } });

    // Sama seperti checkout tunai: alert kritis jika stok menyentuh 0 setelah dipotong
    if (result === 'paid' && !process.env.NODE_TEST_CONTEXT && isEmailConfigured()) {
      triggerCriticalOutOfStockAlerts(transaction.detailBarang.map((item) => item.produk)).catch(() => {});
    }
  } catch (error) {
    if (error.statusCode && error.statusCode !== 500) {
      console.warn(`[Midtrans] order_id=${req.body?.order_id}: ${error.message}`);
    }
    sendError(res, error);
  }
};
