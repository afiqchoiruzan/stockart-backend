const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const reportRoutes = require('./routes/reportRoutes');
const notificationRoutes = require('./routes/notificationRoutes');

const app = express();

// Sembunyikan header X-Powered-By dan pasang security headers standar
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Percayai reverse proxy (Railway / Vercel) agar express-rate-limit membaca IP asli klien
app.set('trust proxy', 1);

const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
    : true;

app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: '100kb' }));

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/notifications', notificationRoutes);

app.get('/', (req, res) => {
    res.send('StockArt API is running...');
});

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Rute tidak ditemukan'
    });
});

app.use((error, req, res, next) => {
    const statusCode = error.statusCode || 500;

    res.status(statusCode).json({
        success: false,
        message: statusCode === 500
            ? 'Terjadi kesalahan pada server'
            : error.message
    });
});

module.exports = app;