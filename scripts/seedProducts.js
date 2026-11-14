'use strict';

const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Product = require('../models/Product');

const products = [
  // SEMBAKO
  { nama: "Beras Maknyuss 5kg", kodeProduk: "SM001", kategori: "Sembako", hargaBeli: 60000, hargaJual: 65000, stok: 20, satuan: "sak", stokMinimum: 5, deskripsi: "Beras premium kualitas super", aktif: true },
  { nama: "Minyak Goreng Bimoli 2L", kodeProduk: "SM002", kategori: "Sembako", hargaBeli: 35000, hargaJual: 38000, stok: 15, satuan: "pouch", stokMinimum: 5, deskripsi: "Minyak goreng kelapa sawit 2 liter", aktif: true },
  { nama: "Gula Pasir Gulaku 1kg", kodeProduk: "SM003", kategori: "Sembako", hargaBeli: 14000, hargaJual: 16000, stok: 30, satuan: "kg", stokMinimum: 10, deskripsi: "Gula pasir putih premium", aktif: true },
  { nama: "Tepung Terigu Segitiga Biru 1kg", kodeProduk: "SM004", kategori: "Sembako", hargaBeli: 10000, hargaJual: 12000, stok: 25, satuan: "kg", stokMinimum: 10, deskripsi: "Tepung terigu serbaguna", aktif: true },
  { nama: "Indomie Goreng Reguler", kodeProduk: "8968601001", kategori: "Sembako", hargaBeli: 2700, hargaJual: 3000, stok: 150, satuan: "bungkus", stokMinimum: 40, deskripsi: "Mie instan goreng sejuta umat", aktif: true },
  { nama: "Indomie Kuah Ayam Bawang", kodeProduk: "8968601002", kategori: "Sembako", hargaBeli: 2600, hargaJual: 3000, stok: 100, satuan: "bungkus", stokMinimum: 20, deskripsi: "Mie instan kuah rasa ayam bawang", aktif: true },
  { nama: "Kecap Manis Bango 520ml", kodeProduk: "SM007", kategori: "Sembako", hargaBeli: 20000, hargaJual: 23000, stok: 12, satuan: "pouch", stokMinimum: 5, deskripsi: "Kecap manis kedelai hitam", aktif: true },
  { nama: "Saus Sambal ABC 340ml", kodeProduk: "SM008", kategori: "Sembako", hargaBeli: 15000, hargaJual: 17500, stok: 10, satuan: "botol", stokMinimum: 3, deskripsi: "Saus sambal ekstra pedas", aktif: true },
  { nama: "Garam Dapur Kapal 250g", kodeProduk: "SM009", kategori: "Sembako", hargaBeli: 2000, hargaJual: 3000, stok: 50, satuan: "bungkus", stokMinimum: 15, deskripsi: "Garam beryodium", aktif: true },
  { nama: "Telur Ayam Negeri (Per Kg)", kodeProduk: "SM010", kategori: "Sembako", hargaBeli: 25000, hargaJual: 28000, stok: 30, satuan: "kg", stokMinimum: 10, deskripsi: "Telur segar harian", aktif: true },

  // MINUMAN
  { nama: "Aqua Botol 600ml", kodeProduk: "MN001", kategori: "Minuman", hargaBeli: 2500, hargaJual: 3500, stok: 120, satuan: "botol", stokMinimum: 24, deskripsi: "Air mineral", aktif: true },
  { nama: "Le Minerale 600ml", kodeProduk: "MN002", kategori: "Minuman", hargaBeli: 2500, hargaJual: 3500, stok: 100, satuan: "botol", stokMinimum: 24, deskripsi: "Air mineral ada manis-manisnya", aktif: true },
  { nama: "Teh Pucuk Harum 350ml", kodeProduk: "MN003", kategori: "Minuman", hargaBeli: 3000, hargaJual: 4000, stok: 50, satuan: "botol", stokMinimum: 10, deskripsi: "Minuman teh botol", aktif: true },
  { nama: "Floridina Orange 350ml", kodeProduk: "MN004", kategori: "Minuman", hargaBeli: 2500, hargaJual: 3500, stok: 45, satuan: "botol", stokMinimum: 10, deskripsi: "Minuman rasa jeruk bulir utuh", aktif: true },
  { nama: "Kopi Kapal Api Mix (Renteng)", kodeProduk: "MN005", kategori: "Minuman", hargaBeli: 12000, hargaJual: 15000, stok: 2, satuan: "renteng", stokMinimum: 5, deskripsi: "Kopi hitam manis isi 10 sachet (Stok Menipis!)", aktif: true },
  { nama: "Susu Bear Brand", kodeProduk: "MN006", kategori: "Minuman", hargaBeli: 9500, hargaJual: 11000, stok: 30, satuan: "kaleng", stokMinimum: 10, deskripsi: "Susu steril beruang", aktif: true },
  { nama: "Pocari Sweat 500ml", kodeProduk: "MN007", kategori: "Minuman", hargaBeli: 6500, hargaJual: 8000, stok: 25, satuan: "botol", stokMinimum: 10, deskripsi: "Minuman isotonik", aktif: true },
  { nama: "Sirup Marjan Melon", kodeProduk: "MN008", kategori: "Minuman", hargaBeli: 18000, hargaJual: 22000, stok: 15, satuan: "botol", stokMinimum: 5, deskripsi: "Sirup rasa melon segar", aktif: true },
  { nama: "Susu Ultra Milk Coklat 250ml", kodeProduk: "MN009", kategori: "Minuman", hargaBeli: 5000, hargaJual: 6500, stok: 40, satuan: "kotak", stokMinimum: 12, deskripsi: "Susu UHT coklat", aktif: true },
  { nama: "Yakult (Pack 5)", kodeProduk: "MN010", kategori: "Minuman", hargaBeli: 9000, hargaJual: 11000, stok: 20, satuan: "pack", stokMinimum: 5, deskripsi: "Minuman probiotik", aktif: true },

  // CEMILAN
  { nama: "Chitato Sapi Panggang 68g", kodeProduk: "MR001", kategori: "Cemilan", hargaBeli: 9000, hargaJual: 11000, stok: 25, satuan: "bungkus", stokMinimum: 10, deskripsi: "Keripik kentang gelombang", aktif: true },
  { nama: "Taro Net Seaweed 65g", kodeProduk: "MR002", kategori: "Cemilan", hargaBeli: 7000, hargaJual: 8500, stok: 30, satuan: "bungkus", stokMinimum: 10, deskripsi: "Snack rasa rumput laut", aktif: true },
  { nama: "Biskuit Roma Kelapa", kodeProduk: "MR003", kategori: "Cemilan", hargaBeli: 8500, hargaJual: 10000, stok: 20, satuan: "bungkus", stokMinimum: 5, deskripsi: "Biskuit kelapa renyah", aktif: true },
  { nama: "Oreo Original 133g", kodeProduk: "MR004", kategori: "Cemilan", hargaBeli: 8000, hargaJual: 9500, stok: 24, satuan: "bungkus", stokMinimum: 10, deskripsi: "Biskuit coklat dengan krim vanilla", aktif: true },
  { nama: "Beng-Beng Regular", kodeProduk: "MR005", kategori: "Cemilan", hargaBeli: 2000, hargaJual: 2500, stok: 50, satuan: "pcs", stokMinimum: 20, deskripsi: "Wafer karamel coklat", aktif: true },
  { nama: "Kacang Garuda Rosta 100g", kodeProduk: "MR006", kategori: "Cemilan", hargaBeli: 8000, hargaJual: 10000, stok: 15, satuan: "bungkus", stokMinimum: 5, deskripsi: "Kacang oven renyah", aktif: true },
  { nama: "Chocolatos Wafer Roll", kodeProduk: "MR007", kategori: "Cemilan", hargaBeli: 1000, hargaJual: 1500, stok: 100, satuan: "pcs", stokMinimum: 25, deskripsi: "Wafer roll rasa coklat", aktif: true },
  { nama: "SilverQueen Kacang Mede 62g", kodeProduk: "MR008", kategori: "Cemilan", hargaBeli: 14000, hargaJual: 17000, stok: 18, satuan: "pcs", stokMinimum: 5, deskripsi: "Coklat bar isi kacang mede", aktif: true },
  { nama: "Qtela Singkong Balado", kodeProduk: "MR009", kategori: "Cemilan", hargaBeli: 13000, hargaJual: 15500, stok: 20, satuan: "bungkus", stokMinimum: 5, deskripsi: "Keripik singkong pedas", aktif: true },
  { nama: "Yupi Gummy Bears", kodeProduk: "MR010", kategori: "Cemilan", hargaBeli: 3500, hargaJual: 4500, stok: 40, satuan: "bungkus", stokMinimum: 15, deskripsi: "Permen jelly bentuk beruang", aktif: true },

  // KEBERSIHAN & MANDI
  { nama: "Deterjen Rinso Anti Noda 770g", kodeProduk: "KB001", kategori: "Kebersihan", hargaBeli: 19000, hargaJual: 22000, stok: 15, satuan: "bungkus", stokMinimum: 5, deskripsi: "Deterjen bubuk", aktif: true },
  { nama: "Sabun Cuci Piring Sunlight 755ml", kodeProduk: "KB002", kategori: "Kebersihan", hargaBeli: 14000, hargaJual: 16500, stok: 20, satuan: "pouch", stokMinimum: 5, deskripsi: "Pencuci piring aroma jeruk nipis", aktif: true },
  { nama: "Sabun Mandi Lifebuoy Merah 110g", kodeProduk: "KB003", kategori: "Perawatan Diri", hargaBeli: 3500, hargaJual: 4500, stok: 45, satuan: "pcs", stokMinimum: 15, deskripsi: "Sabun mandi batang antibakteri", aktif: true },
  { nama: "Shampo Pantene Anti Dandruff 160ml", kodeProduk: "KB004", kategori: "Perawatan Diri", hargaBeli: 21000, hargaJual: 24000, stok: 4, satuan: "botol", stokMinimum: 8, deskripsi: "Shampo anti ketombe (Stok Menipis!)", aktif: true },
  { nama: "Pasta Gigi Pepsodent 190g", kodeProduk: "KB005", kategori: "Perawatan Diri", hargaBeli: 11000, hargaJual: 13500, stok: 25, satuan: "tube", stokMinimum: 8, deskripsi: "Pasta gigi pencegah gigi berlubang", aktif: true },
  { nama: "Sikat Gigi Formula (Pack 3)", kodeProduk: "KB006", kategori: "Perawatan Diri", hargaBeli: 12000, hargaJual: 15000, stok: 15, satuan: "pack", stokMinimum: 5, deskripsi: "Sikat gigi medium", aktif: true },
  { nama: "Baygon Semprot 600ml", kodeProduk: "KB007", kategori: "Kebersihan", hargaBeli: 32000, hargaJual: 36000, stok: 10, satuan: "kaleng", stokMinimum: 3, deskripsi: "Aerosol pembasmi serangga", aktif: true },
  { nama: "Pembersih Lantai Super Sol 800ml", kodeProduk: "KB008", kategori: "Kebersihan", hargaBeli: 12000, hargaJual: 14500, stok: 18, satuan: "pouch", stokMinimum: 5, deskripsi: "Pembersih lantai karbol wangi", aktif: true },
  { nama: "Tisu Wajah Paseo 250s", kodeProduk: "KB009", kategori: "Kebersihan", hargaBeli: 15000, hargaJual: 18000, stok: 30, satuan: "pack", stokMinimum: 10, deskripsi: "Tisu wajah lembut", aktif: true },
  { nama: "Pewangi Pakaian Downy 700ml", kodeProduk: "KB010", kategori: "Kebersihan", hargaBeli: 22000, hargaJual: 26000, stok: 12, satuan: "pouch", stokMinimum: 4, deskripsi: "Softener pakaian", aktif: true },

  // ALAT TULIS & UMUM
  { nama: "Buku Tulis Sidu 38 Lembar (Pack)", kodeProduk: "AT001", kategori: "Alat Tulis", hargaBeli: 28000, hargaJual: 32000, stok: 10, satuan: "pack", stokMinimum: 3, deskripsi: "Buku tulis isi 10", aktif: true },
  { nama: "Pulpen Standard AE7 Hitam", kodeProduk: "AT002", kategori: "Alat Tulis", hargaBeli: 1500, hargaJual: 2500, stok: 60, satuan: "pcs", stokMinimum: 20, deskripsi: "Pulpen tinta hitam", aktif: true },
  { nama: "Pensil 2B Faber Castell", kodeProduk: "AT003", kategori: "Alat Tulis", hargaBeli: 3000, hargaJual: 4500, stok: 40, satuan: "pcs", stokMinimum: 12, deskripsi: "Pensil ujian 2B", aktif: true },
  { nama: "Penghapus Joyko Hitam", kodeProduk: "AT004", kategori: "Alat Tulis", hargaBeli: 1000, hargaJual: 2000, stok: 50, satuan: "pcs", stokMinimum: 15, deskripsi: "Penghapus pensil", aktif: true },
  { nama: "Tipe-X Kertas Joyko", kodeProduk: "AT005", kategori: "Alat Tulis", hargaBeli: 4000, hargaJual: 6000, stok: 20, satuan: "pcs", stokMinimum: 5, deskripsi: "Correction tape", aktif: true },
  { nama: "Baterai ABC Alkalin AA (Pack 2)", kodeProduk: "UM001", kategori: "Umum", hargaBeli: 9000, hargaJual: 12000, stok: 25, satuan: "pack", stokMinimum: 8, deskripsi: "Baterai jam dinding/remote", aktif: true },
  { nama: "Lem Korea Alteco", kodeProduk: "UM002", kategori: "Umum", hargaBeli: 5000, hargaJual: 7500, stok: 30, satuan: "pcs", stokMinimum: 10, deskripsi: "Lem super kuat", aktif: true },
  { nama: "Lakban Bening Daimaru", kodeProduk: "UM003", kategori: "Umum", hargaBeli: 8000, hargaJual: 11000, stok: 1, satuan: "roll", stokMinimum: 5, deskripsi: "Lakban plastik transparan (Stok Kritis!)", aktif: true },
  { nama: "Gunting Kertas Joyko Sedang", kodeProduk: "AT009", kategori: "Alat Tulis", hargaBeli: 6000, hargaJual: 8500, stok: 12, satuan: "pcs", stokMinimum: 4, deskripsi: "Gunting serbaguna", aktif: true },
  { nama: "Korek Api Gas Tokai", kodeProduk: "UM005", kategori: "Umum", hargaBeli: 2000, hargaJual: 3000, stok: 48, satuan: "pcs", stokMinimum: 10, deskripsi: "Korek api gas standar", aktif: true }
];

async function seedProducts() {
  try {
    await connectDB();

    await Product.deleteMany({});
    console.log('Tabel Product lama dikosongkan.');

    await Product.insertMany(products);
    console.log(`✅ Berhasil menambahkan ${products.length} produk baru (Toko Kelontong Full Set) ke database.`);

  } catch (error) {
    console.error('Seeding error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB disconnected.');
  }
}

seedProducts();
