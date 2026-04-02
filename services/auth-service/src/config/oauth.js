require('dotenv').config();

const OAUTH_CONFIG = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3002/auth/google/callback',
    scope: ['openid', 'email', 'profile'],
    
    // OAuth 2.0 endpoints
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  },

  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    redirectUri: process.env.GITHUB_REDIRECT_URI || 'http://localhost:3002/auth/github/callback',
    scope: ['user:email'],
    
    // GitHub OAuth endpoints
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    emailUrl: 'https://api.github.com/user/emails',
  }

  // Easy to extend with more providers like Facebook, Twitter, etc.
};

const getOAuthProvider = (provider) => {
  const config = OAUTH_CONFIG[provider.toLowerCase()];
  if (!config) {
    throw new Error(`OAuth provider '${provider}' is not configured`);
  }
  
  if (!config.clientId || !config.clientSecret) {
    throw new Error(`OAuth provider '${provider}' is missing required credentials`);
  }
  
  return config;
};

const buildAuthUrl = (provider, state) => {
  const config = getOAuthProvider(provider);
  
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scope.join(' '),
    state: state, // CSRF protection
    access_type: 'offline', // For Google to get refresh token
  });

  return `${config.authUrl}?${params.toString()}`;
};

module.exports = {
  OAUTH_CONFIG,
  getOAuthProvider,
  buildAuthUrl,
};