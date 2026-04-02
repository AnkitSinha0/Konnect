const axios = require('axios');
const crypto = require('crypto');
const { getOAuthProvider } = require('../config/oauth');
const redisClient = require('../config/redis');

/**
 * Generate and store a secure state token for CSRF protection
 * @returns {string} Base64 encoded signed state token
 */
const generateStateToken = async () => {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  const timestamp = Date.now();
  const stateData = `${randomBytes}.${timestamp}`;
  
  // Create HMAC signature for state verification
  const secret = process.env.OAUTH_STATE_SECRET || 'fallback-secret';
  const signature = crypto.createHmac('sha256', secret).update(stateData).digest('hex');
  
  const stateToken = Buffer.from(`${stateData}.${signature}`).toString('base64');
  
  // Store in Redis for 5 minutes
  try {
    await redisClient.set(`oauth_state:${stateToken}`, 'valid', { ex: 300 }); // 5 minutes
  } catch (error) {
    console.warn('Redis state storage failed, using fallback:', error.message);
  }
  
  return stateToken;
};

/**
 * Validate OAuth state token for CSRF protection
 * @param {string} stateToken - State token to validate
 * @returns {boolean} True if state is valid
 */
const validateStateToken = async (stateToken) => {
  try {
    // Check Redis first
    const redisValid = await redisClient.get(`oauth_state:${stateToken}`);
    if (redisValid === 'valid') {
      // Remove token after use (one-time use)
      await redisClient.del(`oauth_state:${stateToken}`);
      return true;
    }
    
    // Fallback validation for when Redis is unavailable
    const decoded = Buffer.from(stateToken, 'base64').toString('utf8');
    const [randomBytes, timestamp, signature] = decoded.split('.');
    
    if (!randomBytes || !timestamp || !signature) {
      return false;
    }
    
    // Check timestamp (max 5 minutes old)
    const tokenTime = parseInt(timestamp);
    if (Date.now() - tokenTime > 300000) { // 5 minutes
      return false;
    }
    
    // Verify signature
    const secret = process.env.OAUTH_STATE_SECRET || 'fallback-secret';
    const expectedSig = crypto.createHmac('sha256', secret).update(`${randomBytes}.${timestamp}`).digest('hex');
    
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'));
    
  } catch (error) {
    console.error('State validation error:', error.message);
    return false;
  }
};

/**
 * Exchange authorization code for access token
 * @param {string} provider - OAuth provider (google, github)
 * @param {string} code - Authorization code from OAuth callback
 * @returns {object} Token data from OAuth provider
 */
const exchangeCodeForToken = async (provider, code) => {
  const config = getOAuthProvider(provider);
  
  const tokenData = {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  };

  try {
    const response = await axios.post(config.tokenUrl, tokenData, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.data.access_token) {
      throw new Error('No access token received from OAuth provider');
    }

    return response.data;
  } catch (error) {
    console.error('Token exchange error:', error.response?.data || error.message);
    throw new Error('Failed to exchange authorization code for token');
  }
};

/**
 * Fetch user information from OAuth provider
 * @param {string} provider - OAuth provider (google, github)
 * @param {string} accessToken - Access token from OAuth provider
 * @returns {object} User information from OAuth provider
 */
const fetchUserInfo = async (provider, accessToken) => {
  const config = getOAuthProvider(provider);
  
  try {
    const response = await axios.get(config.userInfoUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    let userData = response.data;

    // GitHub might need additional call for email if it's private
    if (provider === 'github' && !userData.email) {
      try {
        const emailResponse = await axios.get(config.emailUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
          },
        });
        const primaryEmail = emailResponse.data.find(email => email.primary)?.email;
        userData.email = primaryEmail;
      } catch (emailError) {
        console.warn('Could not fetch GitHub user email:', emailError.message);
      }
    }

    return userData;
  } catch (error) {
    console.error('User info fetch error:', error.response?.data || error.message);
    throw new Error('Failed to fetch user information from OAuth provider');
  }
};

/**
 * Normalize user data from different OAuth providers
 * @param {string} provider - OAuth provider (google, github)
 * @param {object} userData - Raw user data from OAuth provider
 * @returns {object} Normalized user data
 */
const normalizeUserData = (provider, userData) => {
  switch (provider.toLowerCase()) {
    case 'google':
      return {
        email: userData.email,
        name: userData.name,
        avatar: userData.picture,
        providerId: userData.id,
        provider: 'google',
        displayName: userData.name,
      };
    
    case 'github':
      return {
        email: userData.email,
        name: userData.name || userData.login,
        avatar: userData.avatar_url,
        providerId: userData.id.toString(),
        provider: 'github',
        displayName: userData.name || userData.login,
      };
    
    default:
      throw new Error(`Unsupported OAuth provider: ${provider}`);
  }
};

module.exports = {
  generateStateToken,
  validateStateToken,
  exchangeCodeForToken,
  fetchUserInfo,
  normalizeUserData,
};