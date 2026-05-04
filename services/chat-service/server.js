require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const redis = require('redis');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const chatRoutes = require('./src/routes/chatRoutes');
const { setRedisClient } = require('./src/controllers/chatController');
const { connectProducer } = require('./src/config/kafka');
const { startSentimentConsumer } = require('./src/config/sentimentConsumer');

// Register models (must be done before any route handlers)
require('./src/models/User');
require('./src/models/Message');
require('./src/models/Conversation');
require('./src/models/FlaggedMessage');

const app = express();
const PORT = process.env.PORT || 3003;

// Redis client for pub/sub
let redisClient;

// CORS configuration  
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  preflightContinue: false,
  optionsSuccessStatus: 200
}));

app.use(express.json());
app.use(cookieParser());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'chat-service',
    version: '1.0.0'
  });
});

// Also expose health check under /api for Traefik routing
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'chat-service',
    version: '1.0.0'
  });
});

// Chat routes
app.use('/api', chatRoutes);

const start = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Chat Service: MongoDB connected');
    
    // Enable Redis connection for pub/sub
    try {
      redisClient = redis.createClient({ url: process.env.REDIS_URL });
      redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));
      redisClient.on('ready', () => console.log('✅ Chat Service: Redis connected'));
      
      await redisClient.connect();
      console.log('✅ Chat Service: Redis pub/sub enabled');
      
      // Pass Redis client to controller
      setRedisClient(redisClient);
      
    } catch (redisError) {
      console.error('⚠️  Chat Service: Redis connection failed, continuing without pub/sub:', redisError.message);
    }

    // Connect Kafka producer for sentiment pipeline
    try {
      await connectProducer();
    } catch (kafkaError) {
      console.error('⚠️  Chat Service: Kafka connection failed, continuing without sentiment:', kafkaError.message);
    }

    // Start sentiment-results consumer (persists flagged messages for analytics)
    // Fire-and-forget: don't block startup if Kafka is slow.
    startSentimentConsumer().catch((err) =>
      console.error('⚠️  Sentiment consumer init failed:', err.message)
    );
    
    app.listen(PORT, () => {
      console.log(`🚀 Chat Service running on port ${PORT}`);
      console.log(`📡 Available endpoints:`);
      console.log(`  POST /api/messages - Send message`);
      console.log(`  GET  /api/messages?conversationId=xxx - Get messages`);
      console.log(`  GET  /api/conversations - Get conversations`);
      console.log(`  POST /api/conversations/direct - Create 1:1 chat`);
      console.log(`  POST /api/conversations/group - Create group chat`);
    });
  } catch (error) {
    console.error('❌ Chat Service startup error:', error);
    process.exit(1);
  }
};

start();