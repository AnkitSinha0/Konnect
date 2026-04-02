const amqp = require('amqplib');

const QUEUE_NAME = 'email_queue';
let channel;

const connectRabbitMQ = async () => {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  console.log('RabbitMQ connected (email-service)');

  connection.on('error', (err) => console.error('RabbitMQ connection error:', err));
  connection.on('close', () => {
    console.error('RabbitMQ connection closed. Exiting...');
    process.exit(1);
  });
};

const getChannel = () => {
  if (!channel) throw new Error('RabbitMQ channel not initialized');
  return channel;
};

const getQueueName = () => QUEUE_NAME;

module.exports = { connectRabbitMQ, getChannel, getQueueName };
