const mongoose = require('mongoose');

// Riwayat barang masuk (penambahan stok) untuk laporan "Produk Masuk".
// Dicatat saat produk baru dibuat dengan stok awal dan saat restock.
const stockEntrySchema = new mongoose.Schema(
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
            required: [true, 'Jumlah barang masuk harus diisi'],
            min: [1, 'Jumlah barang masuk minimal 1'],
        },
        sumber: {
            type: String,
            enum: ['produk_baru', 'restock'],
            required: [true, 'Sumber barang masuk harus diisi'],
        },
        dicatatOleh: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    {
        timestamps: true,
    }
);

stockEntrySchema.index({ createdAt: -1 });

module.exports = mongoose.model('StockEntry', stockEntrySchema);
