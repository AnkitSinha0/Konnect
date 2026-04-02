const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const sendOTPEmail = async (email, otp) => {
  console.log(`📧 Attempting to send OTP email to: ${email}`);
  console.log(`🔧 Using API Key: ${process.env.RESEND_API_KEY ? 'Present' : 'Missing'}`);
  console.log(`📤 From address: ${process.env.EMAIL_FROM}`);

  try {
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Konnect Security <security@navymind.com>',
      to: email,
      subject: '🔐 Your Konnect Security Code',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Konnect Security Code</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
            <div style="background: white; border-radius: 10px; padding: 40px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);">
              <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="margin: 0; color: #333; font-size: 28px; font-weight: 700;">🔐 Konnect Security</h1>
                <p style="margin: 10px 0 0 0; color: #666; font-size: 16px;">Secure Login Verification</p>
              </div>
              
              <div style="text-align: center; margin: 30px 0;">
                <p style="color: #333; font-size: 16px; margin-bottom: 20px;">
                  Enter this verification code to complete your login:
                </p>
                <div style="display: inline-block; background: #f8f9fa; border: 2px solid #4F46E5; border-radius: 8px; padding: 20px 30px; margin: 20px 0;">
                  <div style="font-size: 32px; font-weight: bold; letter-spacing: 0.2em; color: #4F46E5; font-family: 'Courier New', monospace;">
                    ${otp}
                  </div>
                </div>
                <p style="color: #666; font-size: 14px; margin-top: 20px;">
                  ⏱️ <strong>This code expires in 5 minutes</strong>
                </p>
              </div>
              
              <div style="border-top: 1px solid #eee; padding-top: 20px; margin-top: 30px;">
                <p style="color: #888; font-size: 12px; text-align: center; line-height: 1.5;">
                  If you didn't request this code, please ignore this email or contact support if you're concerned about unauthorized access.
                  <br><br>
                  This is an automated message from Konnect Security System.
                </p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) {
      console.error('❌ Resend API Error:', error);
      throw new Error(`Resend error: ${JSON.stringify(error)}`);
    }

    if (data && data.id) {
      console.log(`✅ Email sent successfully! Message ID: ${data.id}`);
      return { success: true, messageId: data.id };
    } else {
      console.error('❌ No data returned from Resend API');
      throw new Error('No response data from Resend API');
    }

  } catch (err) {
    console.error('❌ Failed to send email:', err.message);
    throw err;
  }
};

module.exports = { sendOTPEmail };