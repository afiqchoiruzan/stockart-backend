const mongoose = require('mongoose');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Fungsi Generate Token JWT
const generateToken = (id, sessionId = null) => {
  const payload = sessionId ? { id, sessionId } : { id };
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '8h' // Token berlaku 8 jam (1 shift kerja)
  });
};

// @desc    Register User Baru
// @route   POST /api/auth/register
exports.registerUser = async (req, res) => {
  try {
    const { nama, username, password } = req.body;

    if (!nama || !username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Nama, username, dan password wajib diisi'
      });
    }

    const cleanUsername = String(username).trim();

    // 1. Cek apakah username sudah terdaftar
    const userExists = await User.findOne({ username: cleanUsername });
    if (userExists) {
      return res.status(400).json({ message: 'Username sudah digunakan' });
    }

    // 2. Enkripsi (hash) password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(String(password), salt);

    // 3. Simpan user baru ke MongoDB beserta sessionId aktif
    const sessionId = crypto.randomUUID();
    const user = await User.create({
      nama: String(nama).trim(),
      username: cleanUsername,
      password: hashedPassword,
      role: 'kasir',
      activeSessionId: sessionId
    });

    // 4. Kirim respon sukses beserta token
    res.status(201).json({
      success: true,
      message: 'Registrasi berhasil',
      data: {
        _id: user._id,
        nama: user.nama,
        username: user.username,
        role: user.role,
        token: generateToken(user._id, sessionId)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Login User
// @route   POST /api/auth/login
exports.loginUser = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username dan password wajib diisi'
      });
    }

    // 1. Cari user berdasarkan username (pastikan bertipe string)
    const user = await User.findOne({ username: String(username).trim() });
    if (!user) {
      return res.status(400).json({ message: 'Username atau password salah' });
    }

    // 2. Cek kesesuaian password
    const isMatch = await bcrypt.compare(String(password), user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Username atau password salah' });
    }

    // 3. Khusus kasir: perbarui activeSessionId agar sesi di perangkat lama otomatis gugur
    let sessionId = null;
    if (user.role === 'kasir') {
      sessionId = crypto.randomUUID();
      await User.updateOne(
        { _id: user._id },
        { $set: { activeSessionId: sessionId } }
      );
    }

    // 4. Kirim respon sukses beserta token
    res.json({
      success: true,
      message: 'Login berhasil',
      data: {
        _id: user._id,
        nama: user.nama,
        username: user.username,
        role: user.role,
        token: generateToken(user._id, sessionId)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Lihat Profil Pengguna Aktif
// @route   GET /api/auth/me
exports.getMe = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        _id: req.user._id,
        nama: req.user.nama,
        username: req.user.username,
        role: req.user.role,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Logout Pengguna (Hapus sesi aktif di server)
// @route   POST /api/auth/logout
exports.logoutUser = async (req, res) => {
  try {
    if (req.user && req.user._id) {
      await User.updateOne(
        { _id: req.user._id },
        { $set: { activeSessionId: null } }
      );
    }
    res.status(200).json({
      success: true,
      message: 'Logout berhasil',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Ambil daftar semua akun kasir (khusus pemilik)
// @route   GET /api/auth/cashiers
exports.getCashiers = async (req, res) => {
  try {
    const cashiers = await User.find({ role: 'kasir' })
      .select('_id nama username role createdAt')
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: cashiers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Hapus akun kasir berdasarkan ID (khusus pemilik)
// @route   DELETE /api/auth/cashiers/:id
exports.deleteCashier = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'ID kasir tidak valid' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Akun kasir tidak ditemukan' });
    }
    if (user.role !== 'kasir') {
      return res.status(403).json({ success: false, message: 'Hanya akun dengan role kasir yang dapat dihapus' });
    }

    await User.findByIdAndDelete(id);
    res.status(200).json({
      success: true,
      message: `Akun kasir "${user.username}" berhasil dihapus`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};