const Product = require('../models/Product');
const { sendLowStockAlertEmail } = require('../services/emailService');
const { resetOutOfStockFlags } = require('../services/lowStockAlertService');

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const stripHargaBeliForKasir = (item, role) => {
  if (role !== 'kasir' || !item) return item;
  const obj = typeof item.toObject === 'function' ? item.toObject() : { ...item };
  delete obj.hargaBeli;
  return obj;
};

const isDuplicateKeyError = (error) =>
  error?.code === 11000 || /E11000/i.test(error?.message || '');

// GET /api/products
exports.getProducts = async (req, res) => {
  try {
    const { search, kategori, barcode, aktif } = req.query;
    
    let query = {};

    if (req.user?.role === 'kasir') {
      // Kasir hanya boleh melihat produk yang aktif
      query.aktif = true;
    } else if (aktif === 'all') {
      // tampilkan semua status
    } else if (aktif !== undefined) {
      query.aktif = aktif === 'true';
    } else {
      query.aktif = true;
    }
    
    if (barcode) {
      query.kodeProduk = String(barcode).trim();
    }
    
    if (search) {
      const safeSearch = escapeRegex(search);
      query.$or = [
        { nama: { $regex: safeSearch, $options: 'i' } },
        { kodeProduk: { $regex: safeSearch, $options: 'i' } }
      ];
    }
    
    if (kategori) {
      query.kategori = { $regex: escapeRegex(kategori), $options: 'i' };
    }

    const products = await Product.find(query).sort({ createdAt: -1 });
    const role = req.user?.role;
    const data = role === 'kasir'
      ? products.map((p) => stripHargaBeliForKasir(p, role))
      : products;

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data produk',
      error: error.message,
    });
  }
};

// GET /api/products/low-stock
exports.getLowStockProducts = async (req, res) => {
  try {
    const products = await Product.find({
      aktif: true,
      $expr: { $lte: ['$stok', '$stokMinimum'] }
    }).sort({ stok: 1 });

    const role = req.user?.role;
    const data = role === 'kasir'
      ? products.map((p) => stripHargaBeliForKasir(p, role))
      : products;

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data produk stok menipis',
      error: error.message,
    });
  }
};

// POST /api/products/low-stock/notify
exports.notifyLowStockProducts = async (req, res) => {
  try {
    const products = await Product.find({
      aktif: true,
      $expr: { $lte: ['$stok', '$stokMinimum'] }
    }).sort({ stok: 1 });

    if (products.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Seluruh stok produk dalam kondisi aman (tidak ada yang menipis)',
        data: { sent: false, count: 0 },
      });
    }

    const emailResult = await sendLowStockAlertEmail(products, req.body?.email, {
      context: 'manual',
    });

    res.status(200).json({
      success: true,
      message: `Notifikasi peringatan ${products.length} produk stok menipis berhasil dikirim ke email owner (${emailResult.to})`,
      data: {
        sent: true,
        count: products.length,
        recipient: emailResult.to,
        products,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengirim email peringatan stok menipis',
      error: error.message,
    });
  }
};

// GET /api/products/:id
exports.getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Produk tidak ditemukan',
      });
    }

    res.status(200).json({
      success: true,
      data: stripHargaBeliForKasir(product, req.user?.role),
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'ID produk tidak valid',
    });
  }
};

// POST /api/products
exports.createProduct = async (req, res) => {
  try {
    const product = await Product.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Produk berhasil ditambahkan',
      data: product,
    });
  } catch (error) {
    const message = isDuplicateKeyError(error)
      ? 'Kode produk sudah digunakan oleh produk lain'
      : 'Gagal menambahkan produk';
    res.status(400).json({
      success: false,
      message,
      error: error.message,
    });
  }
};

// PUT /api/products/:id
exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      req.body,
      {
        returnDocument: 'after',
        runValidators: true,
      }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Produk tidak ditemukan',
      });
    }

    if (product.stok > 0 && product.stokHabisNotifiedAt) {
      await resetOutOfStockFlags([product._id]);
      product.stokHabisNotifiedAt = null;
    }

    res.status(200).json({
      success: true,
      message: 'Produk berhasil diperbarui',
      data: product,
    });
  } catch (error) {
    const message = isDuplicateKeyError(error)
      ? 'Kode produk sudah digunakan oleh produk lain'
      : 'Gagal memperbarui produk';
    res.status(400).json({
      success: false,
      message,
      error: error.message,
    });
  }
};

// DELETE /api/products/:id
exports.deleteProduct = async (req, res) => {
  try {
    const { permanent } = req.query;
    const isPermanent = permanent === 'true';

    const product = isPermanent
      ? await Product.findByIdAndDelete(req.params.id)
      : await Product.findByIdAndUpdate(
          req.params.id,
          { aktif: false },
          { returnDocument: 'after' }
        );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Produk tidak ditemukan',
      });
    }

    res.status(200).json({
      success: true,
      message: isPermanent ? 'Produk berhasil dihapus' : 'Produk berhasil dinonaktifkan',
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'ID produk tidak valid',
    });
  }
};

// PATCH /api/products/:id/restore
exports.restoreProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { aktif: true },
      { returnDocument: 'after' }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Produk tidak ditemukan',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Produk berhasil diaktifkan kembali',
      data: product,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'ID produk tidak valid',
    });
  }
};

// PATCH /api/products/:id/restock
exports.restockProduct = async (req, res) => {
  try {
    const { jumlah } = req.body;
    
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $inc: { stok: Number(jumlah) } },
      { returnDocument: 'after', runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Produk tidak ditemukan',
      });
    }

    if (product.stok > 0 && product.stokHabisNotifiedAt) {
      await resetOutOfStockFlags([product._id]);
      product.stokHabisNotifiedAt = null;
    }

    res.status(200).json({
      success: true,
      message: 'Stok berhasil ditambahkan',
      data: product,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Gagal menambahkan stok',
      error: error.message,
    });
  }
};