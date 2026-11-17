const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Middleware untuk memproteksi route (wajib login)
const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    /^Bearer\s+\S+$/.test(req.headers.authorization)
  ) {
    try {
      // Ambil token dari header Authorization: Bearer <TOKEN>
      token = req.headers.authorization.split(' ')[1];

      // Verifikasi token dengan mengunci algoritma HS256
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ['HS256'],
      });

      // Ambil data user dari database (tanpa password)
      req.user = await User.findById(decoded.id).select('-password');

      if (!req.user) {
        return res.status(401).json({ message: 'User tidak ditemukan' });
      }

      if (req.user.aktif === false) {
        return res.status(401).json({ message: 'Akun Anda telah dinonaktifkan oleh pemilik toko' });
      }

      // Khusus kasir: hanya izinkan 1 perangkat aktif & tolak token yang sudah logout
      if (
        req.user.role === 'kasir' &&
        (req.user.activeSessionId || decoded.sessionId) &&
        decoded.sessionId !== req.user.activeSessionId
      ) {
        return res.status(401).json({
          message: 'Sesi berakhir karena akun kasir ini telah logout atau login di perangkat lain'
        });
      }

      next(); // Lanjut ke controller berikutnya
    } catch (error) {
      return res.status(401).json({ message: 'Tidak terotorisasi, token gagal' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Tidak terotorisasi, tidak ada token' });
  }
};

// Middleware opsional untuk membatasi akses berdasarkan role (misal: khusus pemilik)
const authorize = (...roles) => {
  return (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
    message: 'Role tidak memiliki akses ke rute ini'
      });
    }
    next();
  };
};

module.exports = { protect, authorize };