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

// Tentukan field mana yang bentrok (barcode atau kodeProduk) dari error E11000.
const getDuplicateKeyMessage = (error) => {
  const fields = Object.keys(error?.keyPattern || error?.keyValue || {});
  const isBarcode = fields.length
    ? fields.includes('barcode')
    : /barcode/i.test(error?.message || '');
  return isBarcode
    ? 'Barcode sudah digunakan oleh produk lain'
    : 'Kode produk sudah digunakan oleh produk lain';
};

// "" / spasi / null dianggap "tanpa barcode". Jangan pernah simpan "" karena
// index unik sparse tetap mengindeks string kosong dan akan bentrok.
const isEmptyBarcode = (v) =>
  v === null || (typeof v === 'string' && v.trim() === '');

// Filter exact untuk kode hasil scan: cocok dengan `barcode` ATAU `kodeProduk`
// (data lama belum punya barcode). kodeProduk selalu disimpan uppercase, jadi
// pembandingnya ikut di-uppercase.
const barcodeMatchFilter = (code) => {
  const trimmed = String(code).trim();
  return { $or: [{ barcode: trimmed }, { kodeProduk: trimmed.toUpperCase() }] };
};

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
    
    // barcode dan search sama-sama memakai $or, jadi digabung lewat $and
    // agar tidak saling menimpa bila keduanya dikirim.
    const andClauses = [];

    if (barcode) {
      andClauses.push(barcodeMatchFilter(barcode));
    }

    if (search) {
      const safeSearch = escapeRegex(search);
      andClauses.push({ $or: [
        { nama: { $regex: safeSearch, $options: 'i' } },
        { kodeProduk: { $regex: safeSearch, $options: 'i' } }
      ] });
    }

    if (andClauses.length) {
      query.$and = andClauses;
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

// GET /api/products/barcode/:code
exports.getProductByBarcode = async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const role = req.user?.role;

    const query = barcodeMatchFilter(code);
    if (role === 'kasir') {
      // Kasir hanya boleh melihat produk yang aktif
      query.aktif = true;
    }

    // Maksimal 2 kandidat (barcode & kodeProduk masing-masing unik). Jika kode
    // cocok dengan barcode satu produk dan kodeProduk produk lain, utamakan barcode.
    const candidates = code ? await Product.find(query).limit(2) : [];
    const product = candidates.find((p) => p.barcode === code) || candidates[0];

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Produk dengan barcode ini belum terdaftar',
      });
    }

    res.status(200).json({
      success: true,
      data: stripHargaBeliForKasir(product, role),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mencari produk berdasarkan barcode',
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
    const body = { ...req.body };
    if (isEmptyBarcode(body.barcode)) delete body.barcode;

    const product = await Product.create(body);

    res.status(201).json({
      success: true,
      message: 'Produk berhasil ditambahkan',
      data: product,
    });
  } catch (error) {
    const message = isDuplicateKeyError(error)
      ? getDuplicateKeyMessage(error)
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
    const update = { ...req.body };
    if (isEmptyBarcode(update.barcode)) {
      // Barcode dikosongkan → hapus field-nya, bukan menyimpan "".
      delete update.barcode;
      update.$unset = { barcode: 1 };
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      update,
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
      ? getDuplicateKeyMessage(error)
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