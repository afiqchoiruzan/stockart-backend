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

- `GET /api/products` dan `GET /api/products/barcode/:code` bisa diakses `pemilik` dan `kasir`
- `POST`, `PUT`, dan `DELETE /api/products` hanya bisa diakses `pemilik`

### Create Product

Jangan kirim `kodeProduk` untuk menggunakan kode otomatis berformat `PRD-<UUID>`.
Setiap request membuat produk baru dengan kode berbeda. Kode manual tetap
bisa dikirim, tetapi harus unik. `_id` juga dibuat otomatis oleh MongoDB.

Field `barcode` (barcode fisik pada kemasan, mis. EAN-13) terpisah dari `kodeProduk`:

- Opsional. Jika diisi: teks 4–48 karakter tanpa spasi, dan harus unik.
- Produk tanpa barcode boleh banyak (index unik *sparse*). `""` atau `null` dianggap tanpa barcode.
- Pada `PUT`, kirim `"barcode": ""` untuk menghapus barcode produk.
- Barcode duplikat ditolak `400` dengan pesan `"Barcode sudah digunakan oleh produk lain"`.

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

### Get Product By Barcode (Scan)

Lookup satu produk dari hasil scan barcode (kamera atau scanner USB). Kode di-*trim*
lalu dicocokkan *exact* ke `barcode` **atau** `kodeProduk` (produk lama tanpa barcode
tetap bisa ditemukan lewat kode produknya). Jika kode cocok dengan `barcode` satu produk
dan `kodeProduk` produk lain, produk dengan `barcode` yang diutamakan.

- `kasir`: hanya produk aktif, tanpa `hargaBeli`.
- `pemilik`: termasuk produk nonaktif, `hargaBeli` ikut tampil.
- Tidak ditemukan → `404`; tanpa token → `401`.
- Encode kode dengan `encodeURIComponent` bila bisa mengandung karakter khusus (mis. `/`).
- Pasang barcode dulu lewat **Update Product** (contoh di bawah) sebelum mencoba lookup.

```bash
curl -X GET http://localhost:5000/api/products/barcode/8991234567890 \
  -H "Authorization: Bearer $TOKEN"
```

Contoh response `200` (token kasir, tanpa `hargaBeli`):

```json
{
  "success": true,
  "data": {
    "_id": "6a3c1f0e9b1d2c0012ab34cd",
    "nama": "Buku Tulis",
    "kodeProduk": "PRD-3F2A9C1E-7B4D-4E8A-9C21-5D6F7A8B9C0D",
    "barcode": "8991234567890",
    "kategori": "Alat Tulis",
    "hargaJual": 4500,
    "stok": 55,
    "satuan": "pcs",
    "stokMinimum": 5,
    "deskripsi": "Buku tulis ukuran sedang",
    "aktif": true,
    "stokHabisNotifiedAt": null,
    "createdAt": "2026-11-16T03:00:00.000Z",
    "updatedAt": "2026-11-16T03:00:00.000Z",
    "__v": 0
  }
}
```

Contoh response `404`:

```json
{
  "success": false,
  "message": "Produk dengan barcode ini belum terdaftar"
}
```

### Filter Products by Barcode

Sama seperti lookup, tetapi mengembalikan array (kosong jika tidak ada) dan bisa
digabung dengan `search`, `kategori`, dan `aktif`.

```bash
curl -X GET "http://localhost:5000/api/products?barcode=8991234567890" \
  -H "Authorization: Bearer $TOKEN"
```

### Update Product

```bash
curl -X PUT http://localhost:5000/api/products/$PRODUCT_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhYTlmMWYyYzQxZGI3NzhjZmZkODgxYyIsImlhdCI6MTc4OTUyOTQyOSwiZXhwIjoxNzg5NjE1ODI5fQ.eFTg3XkgDCoqSDC59LyAYzUIgD73EVoua72yylPyjY8" \
  -d '{
    "nama": "Pulpen Hitam Premium",
    "hargaJual": 4000,
    "stok": 75,
    "barcode": "8991234567890"
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

```bash
curl -X GET http://localhost:5000/api/reports/summary \
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
6. Jalankan `Update Product (Pemilik Only)` untuk memasang barcode dari variabel `{{barcode}}` (default `8991234567890`), lalu `Get Product by Barcode (Scan)` untuk mencoba lookup. Ulangi dengan `Login Kasir` untuk memastikan `hargaBeli` tidak tampil.

---

## 6. Contoh Alur Test Cepat

1. Jalankan `npm run dev`
2. Jalankan `node scripts/seed.js` untuk membuat akun pemilik default.
3. Login sebagai `pemilik` via `/api/auth/login` dan simpan token ke variable `TOKEN`.
4. Tambah produk (`POST /api/products`) dan simpan ID ke `PRODUCT_ID`.
5. Login sebagai `kasir` via `/api/auth/login`.
6. Kasir membuat transaksi checkout (`POST /api/transactions/checkout`).
7. Pemilik mengecek laporan ringkasan (`GET /api/reports/summary`) dan omzet (`GET /api/reports/revenue`).

