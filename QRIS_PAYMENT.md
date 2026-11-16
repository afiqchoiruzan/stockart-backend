# Pembayaran QRIS (Midtrans Sandbox)

Hanya **sandbox**. `config/midtrans.js` menolak host selain `api.sandbox.midtrans.com`.
Jangan membayar QR sandbox dengan dompet digital asli; gunakan simulator.

## Alur

```
Kasir pilih QRIS
  -> POST /api/payments/qris          transaksi disimpan pending (stok BELUM dipotong), QR dibuat di Midtrans
  -> frontend tampilkan QR, polling GET /api/transactions/:id/status
  -> pelanggan bayar (sandbox: simulator)
  -> Midtrans POST /api/payments/webhook   signature dicek -> paid + stok dipotong (sekali saja)
  -> polling melihat paid -> struk
```

`paid` **hanya** bisa di-set oleh webhook dengan signature valid. Endpoint status hanya membaca,
kecuali menandai `pending` yang sudah lewat `expiresAt` menjadi `expired`.

## Endpoint

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| POST | `/api/payments/qris` | kasir, pemilik | body sama dengan checkout `{detailBarang:[{produk,jumlah}]}` → 201 `data` = transaksi + `qrString`, `expiresAt`, `gatewayRef`, `qrImageUrl` |
| GET | `/api/transactions/:id/status` | login (kasir hanya miliknya) | `{paymentMethod, paymentStatus, paymentNote, stokDipotong, expiresAt, paidAt, totalHarga, status}` |
| POST | `/api/payments/webhook` | **tanpa login**, wajib `signature_key` valid | dipanggil server Midtrans |

### Respons webhook

| Kondisi | HTTP | `data.result` |
|---|---|---|
| signature salah / hilang | 401 | – |
| `order_id` tidak dikenal | 404 (Midtrans akan mencoba ulang) | – |
| `gross_amount` ≠ total transaksi, atau `settlement` dengan `status_code` ≠ `200` | 400 | – |
| `settlement` pertama | 200 | `paid` |
| `settlement` tapi stok kurang / produk terhapus / transaksi sudah dibatalkan | 200 | `paid_with_note` (stok tidak dipotong, `paymentNote` berisi alasan; uang perlu dikembalikan) |
| `settlement` yang sudah diproses (duplikat) | 200 | `duplicate` |
| `expire` | 200 | `expired` (hanya dari pending) |
| `cancel` / `deny` / `failure` | 200 | `failed` (hanya dari pending) |
| `pending`, `refund`, dll. / status sudah final | 200 | `ignored` |

Catatan:
- `settlement` tetap diproses walau status lokal sudah `expired` (pelanggan membayar di detik terakhir).
- Void (`PATCH /api/transactions/:id/void`) ditolak 409 selama QRIS masih `pending`.
- Laporan hanya menghitung transaksi yang tidak `pending`/`expired`/`failed`.

## Environment

```
MIDTRANS_SERVER_KEY=<server key sandbox>        # Dashboard sandbox > Settings > Access Keys
MIDTRANS_BASE_URL=https://api.sandbox.midtrans.com
```

Cek cepat koneksi + key: `npm run qris:try` (membuat QR untuk transaksi dummy, tidak menyentuh DB).

## Webhook di lokal: membuka localhost lewat tunnel

Midtrans perlu URL **publik HTTPS** untuk mengirim webhook; `localhost:5000` tidak bisa dijangkau.

### Opsi A — ngrok

```bash
# sekali saja: daftar di ngrok.com lalu
ngrok config add-authtoken <token-anda>

npm run dev              # terminal 1: backend di port 5000
ngrok http 5000          # terminal 2
```

Salin URL `Forwarding`, mis. `https://abcd-1234.ngrok-free.app`.

### Opsi B — cloudflared (tanpa akun)

```bash
# instal: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:5000
```

Salin URL `https://<acak>.trycloudflare.com` dari log.

URL gratis dari kedua tool **berubah setiap kali tunnel dijalankan ulang**, jadi Notification URL di dashboard perlu diperbarui.

### Mengisi Notification URL di dashboard sandbox

1. Login https://dashboard.sandbox.midtrans.com (pastikan mode **Sandbox**).
2. Buka **Settings → Payment → Notification URL** (di dashboard versi lama: *Settings → Configuration*).
3. Isi **Payment Notification URL**:
   ```
   https://<url-tunnel>/api/payments/webhook
   ```
4. Simpan.

Tombol "Test notification URL" di dashboard mengirim `order_id` contoh yang tidak ada di DB,
jadi backend wajar membalas 404 (atau 401 jika signature contoh tidak cocok dengan key Anda).
Yang penting log backend menampilkan baris `[Midtrans] ...` — artinya tunnel sudah tersambung.

### Uji end-to-end

1. Buat QR: `POST /api/payments/qris` (atau dari POS). Catat `_id` dan `qrImageUrl`.
2. Buka https://simulator.sandbox.midtrans.com/v2/qris/index, tempel `qrImageUrl`, bayar.
3. Log backend: `[Midtrans] order_id=<...> status=settlement -> paid`.
4. `GET /api/transactions/<_id>/status` → `paymentStatus: "paid"`, stok produk berkurang.
5. Dashboard sandbox → Transactions → detail transaksi → bisa "resend notification" untuk menguji duplikat
   (hasilnya `duplicate`, stok tidak berubah).

## Tes otomatis

- `test/payment.test.js` — unit (fetch palsu): charge QRIS, error handling, signature.
- `test/paymentHttp.test.js` — HTTP + MongoDB replica set di **database sementara** (dihapus setelah tes),
  Midtrans dipalsukan: buat QR, status, expired, webhook (signature, idempotensi, bersamaan, stok kurang, void).

## Checklist hasil uji (M7, 2026-11-16)

Kolom **Otomatis** = sudah dijalankan dengan Midtrans dipalsukan (`node --test test/payment.test.js test/paymentHttp.test.js`
→ 32/32 lulus) dan UI kasir diuji di Chrome headless dengan backend dipalsukan.
Kolom **Sandbox** = uji manual memakai Midtrans sandbox + QRIS Simulator; isi setelah dijalankan.

| # | Skenario | Langkah sandbox | Hasil yang diharapkan | Otomatis | Sandbox |
|---|---|---|---|---|---|
| 1 | Berhasil bayar | POS → QRIS → bayar di simulator | Log `-> paid`; stok berkurang; POS menampilkan struk QRIS tanpa refresh | Lulus | Belum |
| 2 | QR expired | Buat QR, tunggu 15 menit tanpa bayar | Status `expired`; POS menampilkan **Buat QR ulang**; stok utuh; tidak masuk laporan | Lulus | Belum |
| 3 | Batal di tengah | Buat QR, klik **Batal** | Modal tertutup, polling berhenti, stok utuh. QR **masih bisa dibayar** sampai kedaluwarsa (lihat Temuan) | Lulus | Belum |
| 4 | Webhook ganda | Setelah #1: dashboard → Transactions → *Resend notification* | Log `-> duplicate`; stok tidak berubah | Lulus (berurutan & bersamaan) | Belum |
| 5 | Signature palsu | `curl` di bawah | HTTP 401, status & stok tidak berubah | Lulus | Belum |
| 6 | Server restart saat pending | Buat QR, matikan backend, bayar di simulator, nyalakan lagi | Midtrans mengirim ulang notifikasi → `paid`; POS (polling) pulih sendiri dan menampilkan struk | Lulus (sisi DB & UI) | Belum |

Uji signature palsu (ganti `<order_id>` dengan `gatewayRef` transaksi pending):

```bash
curl -i -X POST http://localhost:5000/api/payments/webhook \
  -H 'Content-Type: application/json' \
  -d '{"order_id":"<order_id>","status_code":"200","gross_amount":"12000.00","transaction_status":"settlement","signature_key":"palsu"}'
# -> 401 {"success":false,"message":"Signature tidak valid"}
```

### Temuan

- **Batal tidak membatalkan QR di Midtrans.** Pelanggan yang tetap memindai QR lama akan membuat transaksi lunas
  (stok dipotong) yang tidak lagi dipantau POS. Perbaikan: endpoint pembatalan yang memanggil
  `POST /v2/<order_id>/cancel` Midtrans dan menandai transaksi `failed`.
- **Restart server** aman karena status disimpan di MongoDB dan webhook idempoten. Selama server mati, notifikasi
  Midtrans gagal terkirim; Midtrans mengirim ulang otomatis, atau kirim manual lewat *Resend notification*.
  Jika URL ngrok berubah setelah restart, perbarui Notification URL dulu.
- Uji sandbox (kolom terakhir) belum dijalankan karena `MIDTRANS_SERVER_KEY` belum diisi di `.env`.

## Pindah ke production

Jangan lakukan ini selama masih tahap pengembangan. Yang harus diubah:

1. **Server key** — pakai key production dari https://dashboard.midtrans.com (diawali `Mid-server-`, bukan
   `SB-Mid-server-`). Simpan di environment variable hosting (mis. Render: tambahkan `MIDTRANS_SERVER_KEY`
   dan `MIDTRANS_BASE_URL` di `render.yaml`/dashboard dengan `sync: false`), jangan di repo.
2. **Base URL** — `MIDTRANS_BASE_URL=https://api.midtrans.com`. `config/midtrans.js` saat ini **sengaja menolak**
   host selain sandbox, jadi pengecekan itu perlu diubah (mis. izinkan production hanya bila `NODE_ENV=production`).
3. **Notification URL** — di dashboard **production**: `https://<domain-backend>/api/payments/webhook`
   (HTTPS, domain tetap; bukan ngrok).
4. **Aktivasi QRIS** — akun Midtrans production harus lolos verifikasi merchant dan QRIS (acquirer `gopay`) aktif.
5. **Frontend** — hapus tautan *URL gambar QR (untuk simulator sandbox)* di `QrisPaymentModal.js`, dan pastikan
   `NEXT_PUBLIC_API_URL` menunjuk ke backend production.
6. **Disarankan sebelum live** — perbaiki temuan Batal di atas, dan pertimbangkan menyimpan uang bayar di backend
   (saat ini di `localStorage` kasir).
