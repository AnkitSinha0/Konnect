require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const redis = require('redis');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const chatRoutes = require('./src/routes/chatRoutes');

const app = express();
const PORT = process.env.PORT || 3003;

// Redis client for pub/sub
let redisClient;

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
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
    
    // For now, skip Redis connection for testing
    console.log('⚠️  Chat Service: Running without Redis (pub/sub disabled)');
    
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