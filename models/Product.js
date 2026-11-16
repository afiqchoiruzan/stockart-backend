const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');

const productSchema = new mongoose.Schema(
    {
        nama: {
            type: String,
            required: [true, 'Nama produk harus diisi'],
            trim: true,
        },
        kodeProduk: {
            type: String,
            default: () => `PRD-${randomUUID().toUpperCase()}`,
            required: [true, 'Kode produk harus diisi'],
            unique: true,
            immutable: true,
            trim: true,
            uppercase: true,
        },
        // Barcode fisik produk (EAN/UPC/Code128, dll). Opsional; sengaja tanpa default
        // agar produk tanpa barcode tidak menyimpan field ini sama sekali — index sparse
        // hanya memeriksa keunikan pada dokumen yang memiliki barcode.
        barcode: {
            type: String,
            trim: true,
            unique: true,
            sparse: true,
        },
        kategori: {
            type: String,
            trim: true,
        },
        hargaBeli: {
            type: Number,
            required: [true, 'Harga beli harus diisi'],
            min: [0, 'Harga beli tidak boleh kurang dari 0'],
        },
        hargaJual: {
            type: Number,
            required: [true, 'Harga jual harus diisi'],
            min: [0, 'Harga jual tidak boleh kurang dari 0'],
        },
        stok: {
            type: Number,
            required: [true, 'Stok harus diisi'],
            min: [0, 'Stok tidak boleh kurang dari 0'],
            default: 0,
        },
        satuan: {
            type: String,
            trim: true,
            default: 'pcs',
        },
        stokMinimum: {
            type: Number,
            min: [0, 'Stok minimum tidak boleh kurang dari 0'],
            default: 0,
        },
        deskripsi: {
            type: String,
            trim: true,
        },
        aktif: {
            type: Boolean,
            default: true,
        },
        stokHabisNotifiedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model('Product', productSchema);