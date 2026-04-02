const { getChannel, getQueueName } = require('../config/rabbitmq');
const { sendOTPEmail } = require('../services/emailService');

const startEmailConsumer = async () => {
  const channel = getChannel();

  // Process one message at a time
  channel.prefetch(1);

  channel.consume(getQueueName(), async (msg) => {
    if (!msg) return;

    let payload;
    try {
      payload = JSON.parse(msg.content.toString());
    } catch {
      console.error('Failed to parse message — discarding.');
      channel.nack(msg, false, false);
      return;
    }

    const { email, otp } = payload;

    try {
      console.log(`📨 Processing email request for ${email}`);
      const result = await sendOTPEmail(email, otp);
      channel.ack(msg);
      console.log(`✅ Email processing completed for ${email} - Message ID: ${result.messageId}`);
    } catch (err) {
      console.error(`❌ Failed to send email to ${email}:`, err.message);
      // Do not requeue — prevents poison-message loops
      channel.nack(msg, false, false);
    }
  });

  console.log(`Consuming "${getQueueName()}" queue`);
};

module.exports = { startEmailConsumer };
