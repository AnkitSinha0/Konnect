const amqp = require('amqplib');

const QUEUE_NAME = 'email_queue';
let connection;
let channel;
let isConnecting = false;

const connectRabbitMQ = async () => {
  if (isConnecting) {
    console.log('RabbitMQ connection already in progress...');
    return;
  }

  try {
    isConnecting = true;
    console.log('Connecting to RabbitMQ...');
    
    connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    await channel.assertQueue(QUEUE_NAME, { durable: true });
    
    console.log('RabbitMQ connected');

    // Handle connection events
    connection.on('error', async (err) => {
      console.error('RabbitMQ connection error:', err.message);
      channel = null;
      connection = null;
    });
    
    connection.on('close', async () => {
      console.warn('RabbitMQ connection closed, attempting to reconnect...');
      channel = null;
      connection = null;
      // Attempt reconnection after delay
      setTimeout(connectRabbitMQ, 5000);
    });

    // Handle channel events
    channel.on('error', async (err) => {
      console.error('RabbitMQ channel error:', err.message);
      channel = null;
    });
    
    channel.on('close', async () => {
      console.warn('RabbitMQ channel closed');
      channel = null;
    });

  } catch (err) {
    console.error('RabbitMQ connect failed:', err.message);
    channel = null;
    connection = null;
    // Retry connection after delay
    setTimeout(connectRabbitMQ, 5000);
  } finally {
    isConnecting = false;
  }
};

const getChannel = async () => {
  if (!channel) {
    console.log('RabbitMQ channel not available, attempting to reconnect...');
    await connectRabbitMQ();
  }
  return channel;
};

const getQueueName = () => QUEUE_NAME;

module.exports = { connectRabbitMQ, getChannel, getQueueName };
