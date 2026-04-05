const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth');
const {
  register,
  login,
  verifyOtp,
  refreshToken,
  logout,
  oauthLogin,
  oauthCallback,
  searchUsers,
  getCurrentUser
} = require('../controllers/authController');

// Traditional JWT authentication routes
router.post('/register', register);
router.post('/login', login);
router.post('/verify-otp', verifyOtp);
router.post('/refresh-token', refreshToken);
router.post('/logout', logout);

// OAuth authentication routes
router.get('/oauth/:provider', oauthLogin);
router.get('/:provider/callback', oauthCallback);

// Protected user routes
router.get('/users/search', authenticateToken, searchUsers);
router.get('/users/me', authenticateToken, getCurrentUser);

module.exports = router;
