/**
 * Seed Script — Membuat akun pemilik pertama.
 *
 * Cara pakai:
 *   node scripts/seed.js
 *
 * Variabel environment (dari .env atau CLI):
 *   PEMILIK_NAMA      — nama lengkap pemilik (default: "Pemilik Toko")
 *   PEMILIK_USERNAME  — username login pemilik (default: "pemilik")
 *   PEMILIK_PASSWORD  — password pemilik (default: "gantidulu123")
 *
 * Script ini aman dijalankan berulang kali: jika username sudah ada,
 * script tidak membuat duplikat dan langsung keluar dengan pesan.
 */

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const connectDB = require('../config/db');
const User = require('../models/User');

const PEMILIK_NAMA = process.env.PEMILIK_NAMA || 'Pemilik Toko';
const PEMILIK_USERNAME = process.env.PEMILIK_USERNAME || 'pemilik';
const PEMILIK_PASSWORD = process.env.PEMILIK_PASSWORD || 'gantidulu123';

async function seed() {
  await connectDB();

  const existing = await User.findOne({ username: PEMILIK_USERNAME });

  if (existing) {
    console.log(
      `Username "${PEMILIK_USERNAME}" sudah ada (role: ${existing.role}). Tidak ada perubahan.`
    );
    await mongoose.disconnect();
    return;
  }

  const hashedPassword = await bcrypt.hash(PEMILIK_PASSWORD, 10);

  await User.create({
    nama: PEMILIK_NAMA,
    username: PEMILIK_USERNAME,
    password: hashedPassword,
    role: 'pemilik',
  });

  console.log(`✅ Akun pemilik "${PEMILIK_USERNAME}" berhasil dibuat.`);
  console.log(`   Nama     : ${PEMILIK_NAMA}`);
  console.log(`   Username : ${PEMILIK_USERNAME}`);
  console.log(`   Password : ${PEMILIK_PASSWORD}`);
  console.log('   ⚠️  Segera ganti password setelah login pertama!');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed gagal:', err.message);
  process.exit(1);
});
