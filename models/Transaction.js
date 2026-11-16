const mongoose = require('mongoose');

const transactionItemSchema = new mongoose.Schema(
    {
        produk: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'Produk harus diisi'],
        },
        namaProduk: String,
        kodeProduk: String,
        jumlah: {
            type: Number,
            required: [true, 'Jumlah produk harus diisi'],
            min: [1, 'Jumlah produk minimal 1'],
            validate: Number.isSafeInteger,
        },
        hargaSatuan: {
            type: Number,
            required: [true, 'Harga satuan harus diisi'],
            min: [0, 'Harga satuan tidak boleh kurang dari 0'],
        },
        subtotal: {
            type: Number,
            required: [true, 'Subtotal harus diisi'],
            min: [0, 'Subtotal tidak boleh kurang dari 0'],
        },
        // Snapshot harga beli saat checkout untuk laporan laba kotor.
        // Rahasia owner: tidak ikut query biasa dan dihapus dari setiap respons API.
        hargaBeli: {
            type: Number,
            min: [0, 'Harga beli tidak boleh kurang dari 0'],
            select: false,
        },
    },
    {
        _id: false,
    }
);

const hideHargaBeli = (doc, ret) => {
    delete ret.hargaBeli;
    return ret;
};
transactionItemSchema.set('toJSON', { transform: hideHargaBeli });
transactionItemSchema.set('toObject', { transform: hideHargaBeli });

const transactionSchema = new mongoose.Schema(
    {
        kasir: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Kasir harus diisi'],
        },
        detailBarang: {
            type: [transactionItemSchema],
            required: [true, 'Detail barang harus diisi'],
            validate: {
                validator(value) {
                    return value.length > 0;
                },
                message: 'Detail barang minimal berisi 1 produk',
            },
        },
        totalHarga: {
            type: Number,
            required: [true, 'Total harga harus diisi'],
            min: [0, 'Total harga tidak boleh kurang dari 0'],
        },
        // False for historical transactions created before stock deduction existed.
        stokDipotong: { type: Boolean, default: false },
        dibatalkanPada: Date,
        dibatalkanOleh: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        status: {
            type: String,
            enum: ['selesai', 'batal'],
            default: 'selesai',
        },
        // Pembayaran. Transaksi lama (sebelum field ini ada) terbaca sebagai cash + paid.
        paymentMethod: {
            type: String,
            enum: ['cash', 'qris'],
            default: 'cash',
        },
        paymentStatus: {
            type: String,
            enum: ['pending', 'paid', 'expired', 'failed'],
            // Tunai langsung lunas; QRIS menunggu webhook Midtrans.
            default() {
                return this.paymentMethod === 'qris' ? 'pending' : 'paid';
            },
        },
        // order_id yang dikirim ke Midtrans (khusus QRIS).
        gatewayRef: String,
        qrString: String,
        expiresAt: Date,
        paidAt: Date,
        // Diisi webhook jika uang masuk tapi transaksi tidak bisa diselesaikan normal
        // (mis. stok kurang / sudah dibatalkan) -> uang pelanggan perlu dikembalikan.
        paymentNote: String,
    },
    {
        timestamps: true,
    }
);

transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ kasir: 1, createdAt: -1 });
// Webhook mencari transaksi berdasarkan order_id; sparse agar transaksi tunai tidak ikut diindeks.
transactionSchema.index({ gatewayRef: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Transaction', transactionSchema);
