/**
 * Uji coba manual createQris ke Midtrans SANDBOX dengan transaksi dummy.
 *
 * Cara pakai:
 *   npm run qris:try                 # total default Rp1.000
 *   npm run qris:try -- 25000        # total tertentu (bilangan bulat)
 *
 * Sifat script:
 *   - TIDAK menyentuh database; _id transaksi dibuat acak (ObjectId baru).
 *   - Butuh MIDTRANS_SERVER_KEY (sandbox) di .env.
 *   - Server key tidak pernah dicetak.
 *   - Untuk mensimulasikan pembayaran, salin "URL gambar QR" ke
 *     https://simulator.sandbox.midtrans.com/v2/qris/index
 */

'use strict';

const dotenv = require('dotenv');
dotenv.config({ quiet: true });

const mongoose = require('mongoose');
const { createQris } = require('../services/paymentService');

async function main(rawAmount) {
  const totalHarga = rawAmount === undefined ? 1000 : Number(rawAmount);
  const transaction = { _id: new mongoose.Types.ObjectId(), totalHarga };

  console.log(`Membuat QRIS sandbox untuk transaksi dummy ${transaction._id} (Rp${totalHarga})...`);
  const result = await createQris(transaction);

  console.log('Berhasil:');
  console.log(`  gatewayRef (order_id)  : ${result.gatewayRef}`);
  console.log(`  gatewayTransactionId   : ${result.gatewayTransactionId}`);
  console.log(`  expiresAt              : ${result.expiresAt.toISOString()} ` +
    `(${result.expiresAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB)`);
  console.log(`  qrString (${result.qrString.length} karakter): ${result.qrString}`);
  console.log(`  URL gambar QR          : ${result.qrImageUrl}`);
}

if (require.main === module) {
  main(process.argv[2]).catch((err) => {
    console.error(`Gagal membuat QRIS [${err.statusCode || '-'}]: ${err.message}`);
    if (err.gatewayMessage) console.error(`  Pesan Midtrans: ${err.gatewayMessage}`);
    process.exit(1);
  });
}
