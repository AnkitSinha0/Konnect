const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN,
});

// Test connection
(async () => {
  try {
    await redis.ping();
    console.log('✅ Redis REST API connected');
  } catch (error) {
    console.error('❌ Redis connection error:', error.message);
  }
})();

module.exports = redis;
