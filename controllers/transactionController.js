const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const service = require('../services/transactionService');
const { sendLowStockAlertEmail } = require('../services/emailService');

function sendError(res, error) {
  const status = error.statusCode || 500;
  return res.status(status).json({ success: false,
    message: status === 500 ? 'Gagal memproses transaksi' : error.message });
}

exports.getTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find(service.historyFilter(req.query))
      .populate('kasir', 'nama username role')
      .populate('detailBarang.produk', 'nama kodeProduk hargaJual')
      .sort({ createdAt: -1, _id: -1 });
    res.json({ success: true, data: transactions });
  } catch (error) { sendError(res, error); }
};

exports.getTransactionById = async (req, res) => {
  try {
    if (!service.validId(req.params.id)) throw service.fail(400, 'ID transaksi tidak valid');
    const transaction = await Transaction.findById(req.params.id)
      .populate('kasir', 'nama username role')
      .populate('detailBarang.produk', 'nama kodeProduk hargaJual');
    if (!transaction) throw service.fail(404, 'Transaksi tidak ditemukan');
    res.json({ success: true, data: transaction });
  } catch (error) { sendError(res, error); }
};

exports.draftTransaction = async (req, res) => {
  try {
    const draft = await service.calculateTransactionDetail(req.body.detailBarang);
    res.json({ success: true, message: 'Draft transaksi berhasil dihitung', data: draft });
  } catch (error) { sendError(res, error); }
};

exports.createTransaction = async (req, res) => {
  try {
    const transaction = await service.checkout(req.body.detailBarang, req.user._id);
    res.status(201).json({ success: true, message: 'Checkout berhasil', data: transaction });

    // Otomatis kirim email Alert Low Stock ke Owner jika produk yang dibeli menyentuh batas minimum
    if (!process.env.NODE_TEST_CONTEXT && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const productIds = transaction.detailBarang.map((item) => item.produk);
      Product.find({
        _id: { $in: productIds },
        aktif: true,
        $expr: { $lte: ['$stok', '$stokMinimum'] },
      })
        .then((lowProducts) => {
          if (lowProducts.length > 0) {
            return sendLowStockAlertEmail(lowProducts);
          }
        })
        .catch(() => {});
    }
  } catch (error) { sendError(res, error); }
};

exports.cancelTransaction = async (req, res) => {
  try {
    const transaction = await service.voidTransaction(req.params.id, req.user._id);
    res.json({ success: true, message: 'Transaksi berhasil dibatalkan', data: transaction });
  } catch (error) { sendError(res, error); }
};
