const { getChannel, getQueueName } = require('../config/rabbitmq');

/**
 * Publishes an OTP email job to the RabbitMQ email queue.
 */
const sendEmailToQueue = async (email, otp) => {
  try {
    const channel = await getChannel();
    
    if (!channel) {
      console.error('Failed to get RabbitMQ channel for email:', email);
      return false;
    }

    const message = JSON.stringify({ email, otp });
    const result = channel.sendToQueue(getQueueName(), Buffer.from(message), { persistent: true });
    
    if (result) {
      console.log(`Email queued successfully for: ${email}`);
      return true;
    } else {
      console.error('Failed to queue email - channel buffer full:', email);
      return false;
    }
  } catch (error) {
    console.error('Error sending email to queue:', error.message);
    console.error('Failed to queue email for:', email);
    return false;
  }
};

module.exports = { sendEmailToQueue };
