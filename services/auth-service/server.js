require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const connectDB = require('./src/config/db');
const { connectRabbitMQ } = require('./src/config/rabbitmq');
const authRoutes = require('./src/routes/authRoutes');
const errorHandler = require('./src/middlewares/errorHandler');

const app = express(); // Auth microservice - ready to start

// CORS configuration - allow frontend to make requests
app.use((req, res, next) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  res.header('Access-Control-Allow-Origin', frontendUrl);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true'); // for httpOnly cookies
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(cookieParser());

app.use('/', authRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'auth-service',
    version: '1.0.0'
  });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3002;

const start = async () => {
  try {
    await connectDB();
    console.log('Database connected successfully');
  } catch (err) {
    console.error('Database connection failed:', err.message);
    console.log('Starting server without database connection...');
  }

  try {
    await connectRabbitMQ();
    console.log('RabbitMQ connected successfully');
  } catch (err) {
    console.error('RabbitMQ connection failed:', err.message);
    console.log('Starting server without RabbitMQ connection...');
  }

  app.listen(PORT, () => {
    console.log(`Auth service running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV}`);
  });
};

start().catch((err) => {
  console.error('Failed to start auth service:', err);
  process.exit(1);
});
