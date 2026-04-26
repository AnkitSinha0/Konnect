/**
 * Kafka producer for publishing chat messages to the sentiment pipeline.
 * Messages are published to the 'chat_messages' topic.
 */
const { Kafka } = require('kafkajs');

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'kafka:9092';
const TOPIC = process.env.KAFKA_TOPIC || 'chat_messages';

let producer = null;
let connected = false;

const kafka = new Kafka({
  clientId: 'chat-service',
  brokers: [KAFKA_BROKER],
  retry: {
    initialRetryTime: 3000,
    retries: 10,
  },
});

const connectProducer = async () => {
  try {
    producer = kafka.producer();
    await producer.connect();
    connected = true;
    console.log(`✅ Kafka producer connected (broker: ${KAFKA_BROKER}, topic: ${TOPIC})`);
  } catch (err) {
    console.error('⚠️  Kafka producer connection failed:', err.message);
    connected = false;
    // Retry after delay
    setTimeout(connectProducer, 5000);
  }
};

/**
 * Publish a chat message to Kafka for sentiment analysis.
 * Non-blocking — failures are logged but don't break chat flow.
 */
const publishMessage = async (messageData) => {
  if (!connected || !producer) {
    console.log('⚠️  Kafka not connected, skipping sentiment publish');
    return;
  }

  try {
    await producer.send({
      topic: TOPIC,
      messages: [
        {
          key: messageData.conversationId,  // partition by group
          value: JSON.stringify({
            messageId: messageData.messageId,
            conversationId: messageData.conversationId,
            senderId: messageData.senderId,
            content: messageData.content,
            messageType: messageData.messageType || 'text',
            timestamp: messageData.timestamp || new Date().toISOString(),
          }),
        },
      ],
    });
  } catch (err) {
    console.error('⚠️  Kafka publish failed:', err.message);
  }
};

const disconnectProducer = async () => {
  if (producer) {
    await producer.disconnect();
    connected = false;
    console.log('🛑 Kafka producer disconnected');
  }
};

module.exports = { connectProducer, publishMessage, disconnectProducer };
