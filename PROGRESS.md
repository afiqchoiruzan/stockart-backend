# Stockart Backend Progress

Tanggal pemeriksaan: 2026-11-16
Branch kerja: `main`
Commit basis terbaru: `aa7bd99` (`origin/main`)

## Ringkasan Status

| Anggota | Modul | Status | Catatan |
| --- | --- | --- | --- |
| Afiq | Fondasi Express, MongoDB Atlas, dan User schema | Selesai | Terhubung ke MongoDB Atlas Cloud. |
| Afiq | Register, bcrypt, login, JWT, dan middleware role | Selesai dengan Hardening Penuh | Register kasir sekarang wajib diotorisasi oleh role `pemilik` (mencegah pendaftaran kasir liar). |
| Afiq | Proteksi route Product, Transaction, dan Report | Selesai | Seluruh rute API terproteksi JWT & RBAC (`pemilik`/`kasir`). |
| Afiq | Seed script akun pemilik | Selesai | `scripts/seed.js` untuk membuat akun pemilik pertama. Aman dijalankan berulang kali. |
| Afiq | Pengujian RBAC dan HTTP Test | Selesai | Unit RBAC dan HTTP integration test lengkap seluruh endpoint & validasi input. |
| Afiq | Dokumentasi API & Postman Collection | Selesai | `StockArt_API.postman_collection.json` v2.1 dan panduan `API_TESTING.md` siap pakai. |
| Afiq | Staging/deployment | Live 24/7 di Railway | Backend aktif 24 jam nonstop di `https://stockart-backend-production.up.railway.app` (Non-Vercel, No-CC). |
| Bgs | Product schema | Selesai | Mencakup nama, kode produk (unik & auto `PRD-<UUID>`), kategori, harga, stok, satuan, stok minimum, deskripsi, status aktif, dan `stokHabisNotifiedAt`. |
| Bgs | CRUD Product | Selesai | GET list (strip `hargaBeli` untuk kasir), GET detail, POST, PUT, soft/hard DELETE, dan restore; pesan jelas untuk duplikat `kodeProduk`. |
| Ocha | Barcode produk & lookup scan (backend) | Selesai | Field `barcode` opsional/unik/sparse, `?barcode=` mencocokkan `barcode` atau `kodeProduk`, endpoint `GET /api/products/barcode/:code`. Frontend scan kamera menyusul. |
| Bgs | Restock, low-stock, pencarian, filter, & alert terjadwal | Selesai | Restock `$inc`, filter search/kategori/barcode/aktif, `/low-stock` (strip `hargaBeli` untuk kasir), digest terjadwal WIB, alert kritis `stok = 0`, dan endpoint `/api/notifications/low-stock/settings`. |
| Ocha | Transaction schema | Selesai | Schema transaksi sudah tersedia. |
| Ocha | Draft transaksi dan kalkulasi subtotal | Selesai | Validasi produk, jumlah, dan kalkulasi total sudah tersedia. |
| Ocha | Checkout dengan pemotongan stok | Implementasi selesai | Checkout atomik, validasi stok/produk aktif, rollback, dan snapshot harga. |
| Ocha | Riwayat, void, dan pengembalian stok | Implementasi selesai | Filter tanggal WIB/kasir/status; void atomik mempertahankan riwayat dan audit. |
| Izzy | Report dan aggregation | Selesai (Endpoint Terintegrasi) | Endpoint `/api/reports/summary`, `/api/reports/revenue`, dan `/api/reports/top-products` sudah selesai dan teruji. |

## Perubahan Afiq

- Menolak register tanpa nama, username, atau password.
- **Hardening Registrasi:** Membatasi endpoint `POST /api/auth/register` dengan middleware `protect, authorize('pemilik')` agar hanya pemilik toko yang dapat mendaftarkan akun kasir baru.
- Mengabaikan field `role` dari request register publik dan menetapkan role `kasir`.
- Menolak token dengan format Authorization yang tidak valid.
- Mengembalikan `401` jika user pada token sudah tidak ditemukan.
- Menambahkan fallback 404 dan global error handler melalui `app.js`.
- Memisahkan konfigurasi Express dari proses `listen` agar dapat diuji.
- Menambahkan `npm test` menggunakan Node test runner (37 tests).
- Menambahkan test unit RBAC untuk role `pemilik`, `kasir`, dan request tanpa user.
- Menambahkan `scripts/seed.js` untuk membuat akun `pemilik` pertama (aman dijalankan berulang kali; username/password dapat dikustomisasi via env).
- Menambahkan `test/http.test.js` — 33 HTTP integration test yang mencakup seluruh endpoint Auth, Product, Transaction, dan Report dengan token kasir dan pemilik, termasuk verifikasi RBAC (403, 401) dan auto-cleanup data test.
- Menambahkan `middleware/validate.js` — middleware validasi body request per endpoint dengan response error 400 yang deskriptif.
- Menambahkan `middleware/rateLimiter.js` — rate limiter auth (max 10 req/IP/15 menit) untuk mencegah brute-force.
- **Deploy Staging Production:** Backend live 24/7 di **Railway Cloud** (`https://stockart-backend-production.up.railway.app`) dan terhubung ke **MongoDB Atlas**.
- Menyiapkan `render.yaml`, GitHub Actions CI, dan konfigurasi `CORS_ORIGIN`.

## Perubahan Bgs (Stock & Catalog)

- **Schema Produk:** Menyusun schema produk mencakup `nama`, `kodeProduk` (unique), `kategori`, `hargaBeli`, `hargaJual`, `stok`, `satuan`, `stokMinimum`, `deskripsi`, dan `aktif` di `models/Product.js`.
- **CRUD Produk:** Endpoint `GET /api/products`, `GET /api/products/:id`, `POST /api/products`, `PUT /api/products/:id`, dan `DELETE /api/products/:id`. Akses mutasi dibatasi khusus role `pemilik`.
- **Soft Delete (Nonaktifkan Produk):** Endpoint `DELETE /api/products/:id` secara default melakukan soft delete dengan mengubah status menjadi `aktif: false` (respon: `"Produk berhasil dinonaktifkan"`), sehingga menjaga integritas riwayat transaksi masa lalu.
- **Opsi Hapus Permanen:** Menambahkan opsi penghapusan fisik dari MongoDB jika menyertakan query parameter `?permanent=true` (respon: `"Produk berhasil dihapus"`).
- **Fitur Restore Produk:** Menambahkan endpoint `PATCH /api/products/:id/restore` khusus pemilik untuk mengaktifkan kembali produk yang telah dinonaktifkan (`aktif: true`).
- **Filter Katalog Aktif:** `GET /api/products` secara default hanya menampilkan produk aktif di katalog toko, serta mendukung query parameter `?aktif=all` (semua status) dan `?aktif=false` (hanya produk dinonaktifkan). Endpoint `GET /api/products/low-stock` juga difilter hanya untuk produk aktif.
- **Pencarian & Barcode:** Menambahkan pencarian fleksibel berbasis nama/kode produk (`search`), kategori (`kategori`), dan exact match untuk alat barcode scanner (`barcode`) pada endpoint `GET /api/products`.
- **Peringatan Stok Menipis & Hybrid Alert System:**
  - Endpoint `GET /api/products/low-stock` menggunakan ekspresi query `$expr: { $lte: ['$stok', '$stokMinimum'] }` dengan urutan stok terendah dan menyembunyikan `hargaBeli` untuk role `kasir`.
  - **Digest Terjadwal (`lowStockSchedule.js`, `lowStockDigestService.js`):** scheduler persistent berbasis WIB UTC+7 (`off | daily | weekly | monthly`) dengan klaim slot atomik di MongoDB (`NotificationSetting`), tahan restart, catch-up jadwal terlewat, retry maks 3x, serta pembersihan status usang `email_not_configured`.
  - **Alert Kritis Instan `stok = 0` (`lowStockAlertService.js`):** mengirim email kritis 1x saat transaksi checkout kasir menghabiskan stok (`stok <= 0`) dan mereset flag `stokHabisNotifiedAt` otomatis saat restock, edit produk, atau void transaksi.
  - **Manual Trigger & Pengaturan Jadwal:** endpoint `POST /api/products/low-stock/notify` serta `GET/PUT /api/notifications/low-stock/settings` khusus role `pemilik`.
  - **Email Template Monokrom (`emailService.js`):** mendukung Brevo HTTP API + fallback SMTP dengan desain monokrom + aksen merah tanpa emoji, judul teratas `Stockart`, dan konteks subject/header/footer (`digest`, `critical`, `manual`).
- **Fungsi Restock:** Menambahkan endpoint `PATCH /api/products/:id/restock` dengan operator `$inc` dan validasi jumlah bilangan positif minimal 1.
- **Validasi & Integritas Stok:** Menambahkan validasi `productRules`, `productUpdateRules`, `restockRules`, dan `lowStockSettingsRules` di `middleware/validate.js`, constraint schema `min: [0]`, serta pesan spesifik jika `kodeProduk` duplikat.
- **Katalog Seeding:** Menambahkan `scripts/seedProducts.js` berisi 50 sampel produk toko kelontong (Sembako, Minuman, Cemilan, Kebersihan, Perawatan Diri, Alat Tulis, Umum) lengkap dengan sampel produk stok menipis untuk demo.

## Pembaruan Ocha (Transaction)

- Memperketat validasi ObjectId, jumlah bulat aman, produk aktif, dan stok draf.
- Menggabungkan produk duplikat dan menyimpan snapshot nama/kode/harga pada struk.
- Menambahkan `/api/transactions/checkout` dengan transaksi MongoDB dan rollback; endpoint `POST /api/transactions` tetap menjadi alias.
- Menambahkan filter tanggal WIB, kasir, dan status pada riwayat transaksi (`GET /api/transactions`).
- Void mempertahankan riwayat, mencatat pelaku/waktu, dan mengembalikan stok sekali via `PATCH /api/transactions/:id/void`. Transaksi lama tanpa pemotongan stok tidak menambah stok saat dibatalkan.
- Memperbarui dokumentasi kontrak frontend di `TRANSACTION_API.md` dan koleksi Postman.
- Menambahkan test suite `test/transaction.test.js` mencakup rollback, checkout/void bersamaan, validasi stok, dan filter tanggal WIB.

## Pembaruan Ocha — Barcode Scan Backend (2026-11-16, branch `feature/barcode-scan`)

- **Field `barcode` di Product:** opsional, `trim`, `unique` + `sparse` (tanpa default, sehingga banyak produk tanpa barcode tidak saling bentrok). `kodeProduk` tidak berubah.
- **Validasi:** `barcode` 4–48 karakter tanpa spasi pada `productRules` & `productUpdateRules`. `""`/`null` berarti tanpa barcode; pada update, barcode kosong di-`$unset` (bukan disimpan `""`).
- **Pesan duplikat per field:** `"Barcode sudah digunakan oleh produk lain"` vs `"Kode produk sudah digunakan oleh produk lain"` (dibaca dari `keyPattern` error E11000).
- **Pencarian:** `GET /api/products?barcode=` kini exact (trim) ke `barcode` **atau** `kodeProduk`, digabung dengan `?search=` lewat `$and`.
- **Lookup scan:** `GET /api/products/barcode/:code` (pemilik & kasir, didaftarkan sebelum `/:id`). Kasir hanya produk aktif tanpa `hargaBeli`; barcode diutamakan atas `kodeProduk`; 404 `"Produk dengan barcode ini belum terdaftar"`.
- **Test:** tambahan di `test/product.test.js` (DB sementara) dan `test/http.test.js` (RBAC 200/401/404, `hargaBeli` tersembunyi untuk kasir, produk nonaktif tidak ketemu kasir).
- **Dokumentasi:** `API_TESTING.md`, `README.md`, dan Postman (`Get Product by Barcode (Scan)`, variabel `{{barcode}}`).
- **Seeder barcode dummy (`scripts/seedBarcodes.js`, `npm run seed:barcodes`):** mengisi EAN-13 `200` + 9 digit urut + check digit untuk produk tanpa barcode; idempoten, `--dry-run` (rencana saja), `--force` (nomori ulang hanya barcode dummy `200...`), error duplikat per produk tidak menghentikan proses, dan ekspor `scripts/output/barcodes.csv` (di-ignore Git). Unit test di `test/seedBarcodes.test.js`.
- **Lembar barcode demo (`scripts/generateBarcodeSheet.js`, `npm run barcode:sheet`):** HTML kartu produk dengan SVG EAN-13 (fallback CODE128) via `bwip-js`, CSS cetak A4 12 kartu/halaman. Diverifikasi: 121/121 barcode terbaca ZXing dari screenshot layar dan dari PDF A4 150 dpi, semua sama dengan DB. Unit test di `test/generateBarcodeSheet.test.js`.
- **Uji di DB pengembangan:** dry run tidak mengubah DB; run pertama mengisi 121/121 produk; run kedua 0 perubahan; lookup `2000000000015` → `SM001` dan `2000000000053` → `8968601001`; CSV 121 baris data.

## Perubahan Izzy (Report)

- Menambahkan endpoint statistik ringkas `GET /api/reports/summary` (total produk, total transaksi selesai, total omzet) dengan filter rentang tanggal.
- Menambahkan query agregasi omzet harian `GET /api/reports/revenue` (`$dateToString: '%Y-%m-%d'`) untuk visualisasi grafik tren penjualan.
- Menambahkan query produk terlaris `GET /api/reports/top-products` (`$unwind`, `$group`, `$sort: { totalTerjual: -1 }`, `$limit: 5`) dengan nama produk, kuantitas terjual, dan total omzet per produk.
- Mengamankan seluruh rute laporan dengan RBAC khusus role `pemilik` di `routes/reportRoutes.js`.

## Validasi & Test Suite (Pembaruan 2026-11-16)

```text
npm test
138 tests passed, 0 failed, 0 skipped (seluruh 13 file test:
  criticalAlert.test.js, email.test.js, generateBarcodeSheet.test.js, http.test.js,
  lowStockDigest.test.js, lowStockSchedule.test.js,
  lowStockSettings.test.js, notificationRoutes.test.js,
  product.test.js, rbac.test.js, report.test.js,
  seedBarcodes.test.js, transaction.test.js)

Frontend (stockart-frontend):
npm run lint   -> 0 error
npm run build  -> 15 route built sukses
```

## Langkah Selanjutnya (Deployment & Maintenance)

1. Merge PR perbaikan final produk/kasir (`fix/product-polish-and-progress-docs` di backend & `fix/product-lowstock-and-error-ux` di frontend) ke `main`.
2. Pastikan auto-deploy Railway (backend) & Vercel (frontend) aktif serta environment variables produksi (`MONGO_URI`, `JWT_SECRET`, `CORS_ORIGIN`, `BREVO_API_KEY`, `EMAIL_FROM`, `OWNER_EMAIL`) terkonfigurasi lengkap.


## Pembaruan Ocha — 2026-09-29

- Memperketat validasi ObjectId, jumlah bulat aman, produk aktif, dan stok draf.
- Menggabungkan produk duplikat dan menyimpan snapshot nama/kode/harga pada struk.
- Menambahkan `/api/transactions/checkout` dengan transaksi MongoDB dan rollback;
  endpoint POST lama tetap menjadi alias.
- Menambahkan filter tanggal WIB, kasir, dan status pada riwayat transaksi.
- Void mempertahankan riwayat, mencatat pelaku/waktu, dan mengembalikan stok sekali.
  Transaksi lama tanpa pemotongan stok tidak menambah stok saat dibatalkan.
- Memperbarui dokumentasi kontrak frontend dan koleksi Postman.
- Validasi lokal: **48 tests passed, 0 failed**, memakai MongoDB replica set terpisah;
  mencakup rollback, checkout/void bersamaan, login kasir, RBAC, laporan, dan filter WIB.
- `git diff --check` bersih. UAT bersama Afiq/Bgs, penerimaan frontend, dan keputusan
  code freeze belum dilakukan; bukan bagian yang dapat dinyatakan selesai secara otomatis.
