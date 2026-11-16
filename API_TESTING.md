# API Testing dengan cURL

Base URL default:

```bash
http://localhost:5000
```

Jalankan server:

```bash
npm run dev
```

## 1. Auth

### Register Pemilik

```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "nama": "Owner StockArt",
    "username": "owner",
    "password": "password123",
    "role": "pemilik"
  }'
```

### Register Kasir

```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "nama": "Kasir StockArt",
    "username": "kasir",
    "password": "password123",
    "role": "kasir"
  }'
```

### Login

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "owner",
    "password": "password123"
  }'
```

Simpan token dari response login:

```bash
TOKEN="isi_token_dari_response_login"
```

## 2. Product CRUD

Catatan role:

- `GET /api/products` bisa diakses `pemilik` dan `kasir`
- `POST`, `PUT`, dan `DELETE /api/products` hanya bisa diakses `pemilik`

### Create Product

Jangan kirim `kodeProduk` untuk menggunakan kode otomatis berformat `PRD-<UUID>`.
Setiap request membuat produk baru dengan kode berbeda. Kode manual/barcode tetap
bisa dikirim, tetapi harus unik. `_id` juga dibuat otomatis oleh MongoDB.

```bash
curl -X POST http://localhost:5000/api/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8" \
  -d '{
    "nama": "Buku Tulis",
    "kategori": "Alat Tulis",
    "hargaBeli": 3000,
    "hargaJual": 4500,
    "stok": 55,
    "satuan": "pcs",
    "stokMinimum": 5,
    "deskripsi": "Buku tulis ukuran sedang",
    "aktif": true
  }'
```

Simpan `_id` produk dari response:

```bash
PRODUCT_ID="isi_id_produk"
```

### Get All Products

```bash
curl -X GET http://localhost:5000/api/products \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8"
```

### Get Product By ID

```bash
curl -X GET http://localhost:5000/api/products/$PRODUCT_ID \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8"
```

### Update Product

```bash
curl -X PUT http://localhost:5000/api/products/$PRODUCT_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8" \
  -d '{
    "nama": "Pulpen Hitam Premium",
    "hargaJual": 4000,
    "stok": 75
  }'
```

### Delete Product

```bash
curl -X DELETE http://localhost:5000/api/products/$PRODUCT_ID \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8"
```

## 3. Transaction

Kontrak lengkap, kebutuhan replica set, filter WIB, dan kompatibilitas data lama: [TRANSACTION_API.md](TRANSACTION_API.md).

Catatan role:

- `GET /api/transactions` bisa diakses `pemilik` dan `kasir`
- `POST /api/transactions/draft` bisa diakses `pemilik` dan `kasir`
- `POST /api/transactions` bisa diakses `pemilik` dan `kasir`
- `PATCH /api/transactions/:id/cancel` hanya bisa diakses `pemilik`

Pastikan kamu punya minimal 1 produk. Gunakan `PRODUCT_ID` dari produk yang sudah dibuat.

### Draft Transaction

Endpoint ini menghitung subtotal dan total tanpa menyimpan transaksi ke database.

```bash
curl -X POST http://localhost:5000/api/transactions/draft \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8" \
  -d '{
    "detailBarang": [
      {
        "produk": "'"$PRODUCT_ID"'",
        "jumlah": 2
      }
    ]
  }'
```

### Create Transaction

Endpoint ini menyimpan transaksi dan memotong stok secara atomik. `hargaSatuan`, `subtotal`, dan `totalHarga` dihitung otomatis dari harga produk di database.

```bash
curl -X POST http://localhost:5000/api/transactions/checkout \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8" \
  -d '{
    "detailBarang": [
      {
        "produk": "'"$PRODUCT_ID"'",
        "jumlah": 2
      }
    ]
  }'
```

Simpan `_id` transaksi dari response:

```bash
TRANSACTION_ID="isi_id_transaksi"
```

### Get All Transactions

```bash
curl -X GET http://localhost:5000/api/transactions \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8"
```

### Get Transaction By ID

```bash
curl -X GET http://localhost:5000/api/transactions/6aaa0956c41db778cffd8820 \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8"
```

### Cancel Transaction

Endpoint ini mengubah status menjadi `batal` dan mengembalikan stok secara atomik. Riwayat tetap disimpan; void berulang ditolak (409). Alias baru: `PATCH /api/transactions/:id/void`.

```bash
curl -X PATCH http://localhost:5000/api/transactions/6aaa0956c41db778cffd8820/cancel \
  -H "Authorization: Bearer $TOKEN"
```

## 4. Reports (Hanya Pemilik)

### Get Summary

Respons berisi `totalProduk`, `totalTransaksi`, `totalOmzet`, `totalTerjual` (jumlah unit terjual dari transaksi selesai), dan `totalMasuk` (jumlah unit barang masuk dari produk baru & restock). Riwayat barang masuk mulai tercatat sejak fitur ini aktif.

```bash
curl -X GET "http://localhost:5000/api/reports/summary?tanggalMulai=2026-11-10&tanggalAkhir=2026-11-16" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Revenue (Omzet Harian)

```bash
curl -X GET http://localhost:5000/api/reports/revenue \
  -H "Authorization: Bearer $TOKEN"
```

### Get Revenue per Jam (Grafik Harian)

Omzet dikelompokkan per jam WIB (`"jam": "00"` s/d `"23"`). Semua filter tanggal laporan (`tanggalMulai`, `tanggalAkhir`) memakai format `YYYY-MM-DD` dan dihitung dalam WIB.

```bash
curl -X GET "http://localhost:5000/api/reports/revenue?interval=jam&tanggalMulai=2026-11-16&tanggalAkhir=2026-11-16" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Top Products (Produk Terlaris)

```bash
curl -X GET http://localhost:5000/api/reports/top-products \
  -H "Authorization: Bearer $TOKEN"
```

## 4b. Notifications & Low Stock Alert (Hanya Pemilik)

Sistem menggunakan arsitektur hybrid:
- **Digest Terjadwal:** 1 email rekap produk dengan `stok <= stokMinimum` sesuai jadwal WIB (`off | daily | weekly | monthly`, status & slot terakhir disimpan di MongoDB).
- **Alert Kritis (`stok = 0`):** email segera dikirim 1 kali saat kasir checkout membuat produk habis (`stokHabisNotifiedAt` di-reset otomatis saat restock/update/void mengembalikan `stok > 0`).
- **Manual Trigger:** `POST /api/products/low-stock/notify` tetap tersedia untuk kirim rekap kapan saja.

### Get Low Stock Alert Settings

```bash
curl -X GET http://localhost:5000/api/notifications/low-stock/settings \
  -H "Authorization: Bearer $TOKEN"
```

### Update Low Stock Alert Settings

Field yang didukung (bisa update parsial):
- `digestFrequency`: `"off" | "daily" | "weekly" | "monthly"`
- `digestTime`: format `"HH:mm"` (WIB UTC+7, mis. `"07:00"`)
- `digestWeekday`: `0..6` (`0` = Minggu, `1` = Senin, ..., `6` = Sabtu)
- `digestDayOfMonth`: `1..28`
- `criticalAlertEnabled`: `true | false`

```bash
curl -X PUT http://localhost:5000/api/notifications/low-stock/settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "digestFrequency": "weekly",
    "digestTime": "07:00",
    "digestWeekday": 1,
    "digestDayOfMonth": 1,
    "criticalAlertEnabled": true
  }'
```

### Trigger Manual Rekap Low Stock

```bash
curl -X POST http://localhost:5000/api/products/low-stock/notify \
  -H "Authorization: Bearer $TOKEN"
```

## 4c. Kirim Laporan Otomatis (Hanya Pemilik)

Laporan dikirim ke email owner sesuai jadwal WIB. Rentang laporan selalu berupa hari penuh sebelum tanggal jadwal: `daily` = kemarin, `weekly` = 7 hari terakhir, `monthly` = sejak tanggal yang sama bulan lalu. Default `off` sampai owner mengaktifkannya. Pengiriman instan tetap tersedia lewat `POST /api/reports/send-email`.

### Get Report Auto-Send Settings

```bash
curl -X GET http://localhost:5000/api/notifications/report/settings \
  -H "Authorization: Bearer $TOKEN"
```

### Update Report Auto-Send Settings

Field yang didukung (bisa update parsial):
- `digestFrequency`: `"off" | "daily" | "weekly" | "monthly"`
- `digestTime`: format `"HH:mm"` (WIB UTC+7)
- `digestWeekday`: `0..6` (`0` = Minggu, `1` = Senin, ..., `6` = Sabtu)
- `digestDayOfMonth`: `1..28`
- `saveToDrive`: `true | false` (butuh `GDRIVE_WEBHOOK_URL`; lihat `driveConfigured` di respons)

```bash
curl -X PUT http://localhost:5000/api/notifications/report/settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "digestFrequency": "weekly",
    "digestTime": "07:00",
    "digestWeekday": 1,
    "saveToDrive": true
  }'
```

---

## 5. Postman Collection

File Postman Collection v2.1 telah disediakan di root proyek:
- File: `StockArt_API.postman_collection.json`

### Cara Penggunaan:
1. Buka aplikasi **Postman**.
2. Klik tombol **Import**, lalu pilih file `StockArt_API.postman_collection.json`.
3. Buka request `1. Auth > Login Pemilik` atau `Login Kasir`, lalu klik **Send**.
4. Token JWT akan otomatis tersimpan ke variabel environment Postman dan siap digunakan untuk seluruh endpoint lainnya.
5. Jalankan `Create Product (Pemilik Only)` tanpa field `kodeProduk`. Request ini bisa diulang tanpa mengubah body; `_id` hasilnya otomatis disimpan sebagai `product_id` untuk request berikutnya. Import ulang koleksi jika masih menggunakan versi lama dengan kode tetap.

---

## 6. Contoh Alur Test Cepat

1. Jalankan `npm run dev`
2. Jalankan `node scripts/seed.js` untuk membuat akun pemilik default.
3. Login sebagai `pemilik` via `/api/auth/login` dan simpan token ke variable `TOKEN`.
4. Tambah produk (`POST /api/products`) dan simpan ID ke `PRODUCT_ID`.
5. Login sebagai `kasir` via `/api/auth/login`.
6. Kasir membuat transaksi checkout (`POST /api/transactions/checkout`).
7. Pemilik mengecek laporan ringkasan (`GET /api/reports/summary`) dan omzet (`GET /api/reports/revenue`).

