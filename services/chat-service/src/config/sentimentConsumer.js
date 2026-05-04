/**
 * Kafka consumer for sentiment-service results.
 *
 * Subscribes to `sentiment_results` and persists per-message toxicity into
 * MongoDB so the moderation dashboard can compute "Top Toxic Members"
 * historically (the existing Redis sliding window only keeps the last 50
 * entries and has no senderId).
 *
 * We persist when:
 *   - data.flagged === true  (always)
 *   - OR data.toxicity >= PERSIST_TOXICITY_FLOOR (analytics signal)
 *
 * Failures are swallowed — moderation analytics is best-effort and should
 * never affect chat throughput.
 */

const { Kafka } = require('kafkajs');
const FlaggedMessage = require('../models/FlaggedMessage');

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'kafka:9092';
const TOPIC_OUT = process.env.KAFKA_TOPIC_OUT || 'sentiment_results';
const PERSIST_TOXICITY_FLOOR = parseFloat(
  process.env.PERSIST_TOXICITY_FLOOR || '0.5'
);
const PERSIST_CONTENT_SNIPPETS =
  process.env.PERSIST_CONTENT_SNIPPETS === 'true';

let consumer = null;
let running = false;

const kafka = new Kafka({
  clientId: 'chat-service-sentiment-consumer',
  brokers: [KAFKA_BROKER],
  retry: { initialRetryTime: 3000, retries: 10 },
});

const isValidObjectId = (v) =>
  typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);

const startSentimentConsumer = async () => {
  if (running) return;
  try {
    consumer = kafka.consumer({ groupId: 'chat-service-sentiment-consumer' });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC_OUT, fromBeginning: false });
    running = true;
    console.log(
      `✅ Chat Service: sentiment consumer connected (topic: ${TOPIC_OUT}, floor: ${PERSIST_TOXICITY_FLOOR})`
    );

    await consumer.run({
      eachMessage: async ({ message }) => {
        try {
          const data = JSON.parse(message.value.toString());
          if (data.type !== 'per_message') return;

          const toxicity = Number(data.toxicity);
          if (!Number.isFinite(toxicity)) return;
          if (!data.flagged && toxicity < PERSIST_TOXICITY_FLOOR) return;

          if (!isValidObjectId(data.conversationId) || !isValidObjectId(data.senderId)) {
            return;
          }

          await FlaggedMessage.create({
            conversationId: data.conversationId,
            senderId: data.senderId,
            messageId: isValidObjectId(data.messageId) ? data.messageId : null,
            toxicity,
            sentiment: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'].includes(data.sentiment)
              ? data.sentiment
              : 'NEUTRAL',
            flagged: !!data.flagged,
            contentSnippet:
              PERSIST_CONTENT_SNIPPETS && typeof data.content === 'string'
                ? data.content.slice(0, 200)
                : null,
          });
        } catch (err) {
          // Never let analytics persistence crash the consumer loop
          console.error('⚠️  FlaggedMessage persist failed:', err.message);
        }
      },
    });
  } catch (err) {
    running = false;
    console.error('⚠️  Chat Service: sentiment consumer failed to start:', err.message);
    // Soft retry after delay so transient Kafka outages don't kill analytics
    setTimeout(() => {
      console.log('🔄 Retrying sentiment consumer connection...');
      startSentimentConsumer();
    }, 15000);
  }
};

const stopSentimentConsumer = async () => {
  running = false;
  if (consumer) {
    try {
      await consumer.disconnect();
      console.log('🛑 Sentiment consumer disconnected');
    } catch (_) {}
  }
};

module.exports = { startSentimentConsumer, stopSentimentConsumer };
