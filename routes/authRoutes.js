const express = require('express');
const router = express.Router();

const { registerUser, loginUser, getMe, logoutUser, getCashiers, updateCashier, deleteCashier } = require('../controllers/authController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { authRateLimiter } = require('../middleware/rateLimiter');
const { validate, registerRules, loginRules } = require('../middleware/validate');

// Endpoint register & kelola kasir hanya dapat diakses oleh role pemilik (RBAC)
router.post('/register', protect, authorize('pemilik'), authRateLimiter, validate(registerRules), registerUser);
router.get('/cashiers', protect, authorize('pemilik'), getCashiers);
router.patch('/cashiers/:id', protect, authorize('pemilik'), updateCashier);
router.delete('/cashiers/:id', protect, authorize('pemilik'), deleteCashier);
router.post('/login', authRateLimiter, validate(loginRules), loginUser);
router.post('/logout', protect, logoutUser);
router.get('/me', protect, getMe);

module.exports = router;