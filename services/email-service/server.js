require('dotenv').config();
const { connectRabbitMQ } = require('./src/config/rabbitmq');
const { startEmailConsumer } = require('./src/consumers/emailConsumer');

const start = async () => {
  await connectRabbitMQ();
  await startEmailConsumer();
  console.log('Email service running and consuming queue...');
};

start().catch((err) => {
  console.error('Email service failed to start:', err);
  process.exit(1);
});
