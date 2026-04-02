const crypto = require('crypto');
const bcrypt = require('bcrypt');
const redis = require('../config/redis');

const OTP_KEY_PREFIX = 'otp:';
const OTP_ATTEMPTS_PREFIX = 'otp_attempts:';
const OTP_TTL_SECONDS = 300; // 5 minutes
const MAX_ATTEMPTS = 5;

/**
 * Generates a cryptographically random 6-digit OTP.
 */
const generateOTP = () => {
  return crypto.randomInt(100000, 999999).toString();
};

/**
 * Hashes the OTP and stores it in Redis with a 5-minute TTL.
 * Resets the attempt counter on each new OTP request.
 */
const storeOTP = async (email, otp) => {
  const hashed = await bcrypt.hash(otp, 10);
  await redis.set(`${OTP_KEY_PREFIX}${email}`, hashed, { ex: OTP_TTL_SECONDS });
  await redis.del(`${OTP_ATTEMPTS_PREFIX}${email}`);
};

/**
aaaaaaaaaaaaaaaaa * Verifies a plain-text OTP against the stored hash.
 * Enforces a max-attempt limit. Deletes the OTP on success.
 */
const verifyOTP = async (email, otp) => {
  const attemptsKey = `${OTP_ATTEMPTS_PREFIX}${email}`;

  const attempts = await redis.incr(attemptsKey);
  if (attempts === 1) {
    // Align attempt TTL with OTP TTL
    await redis.expire(attemptsKey, OTP_TTL_SECONDS);
  }

  if (attempts > MAX_ATTEMPTS) {
    throw new Error('Maximum OTP attempts exceeded. Please request a new OTP.');
  }

  const stored = await redis.get(`${OTP_KEY_PREFIX}${email}`);
  if (!stored) {
    throw new Error('OTP expired or not found.');
  }

  const isValid = await bcrypt.compare(otp, stored);
  if (!isValid) {
    throw new Error('Invalid OTP.');
  }

  // Clean up on successful verification
  await redis.del(`${OTP_KEY_PREFIX}${email}`);
  await redis.del(attemptsKey);

  return true;
};

/**
 * Manually removes an OTP and its attempt counter from Redis.
 */
const deleteOTP = async (email) => {
  await redis.del(`${OTP_KEY_PREFIX}${email}`);
  await redis.del(`${OTP_ATTEMPTS_PREFIX}${email}`);
};

module.exports = { generateOTP, storeOTP, verifyOTP, deleteOTP };
