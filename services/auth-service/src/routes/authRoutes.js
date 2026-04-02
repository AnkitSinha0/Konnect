const express = require('express');
const router = express.Router();
const {
  register,
  login,
  verifyOtp,
  refreshToken,
  logout,
  oauthLogin,
  oauthCallback,
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

module.exports = router;
