const bcrypt = require('bcrypt');
const crypto = require('crypto');
const User = require('../models/User');
const { generateOTP, storeOTP, verifyOTP } = require('../services/otpService');
const { sendEmailToQueue } = require('../services/emailProducer');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require('../services/tokenService');

// OAuth imports
const { buildAuthUrl } = require('../config/oauth');
const {
  generateStateToken,
  validateStateToken,
  exchangeCodeForToken,
  fetchUserInfo,
  normalizeUserData,
} = require('../services/oauthService');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
};


const register = async (req, res, next) => {
  try {
    const { name, email, password, username } = req.body;

    if (!name || !email || !password || !username) {
      return res.status(400).json({ message: 'Name, email, password, and username are required.' });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: 'Invalid email address.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }

    if (username.length < 3) {
      return res.status(400).json({ message: 'Username must be at least 3 characters.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const existingEmail = await User.findOne({ email });
    const existingUsername = await User.findOne({ username });

    if (existingEmail && existingEmail.isVerified) {
      return res.status(409).json({ message: 'Email is already registered.' });
    }

    if (existingUsername && existingUsername.isVerified) {
      return res.status(409).json({ message: 'Username is already taken.' });
    }

    if (existingEmail && !existingEmail.isVerified) {
      // Allow re-registration of unverified accounts
      existingEmail.name = name;
      existingEmail.username = username;
      existingEmail.password = hashedPassword;
      // Ensure userCode exists
      if (!existingEmail.userCode) {
        existingEmail.userCode = 'KC' + Date.now().toString().slice(-6);
      }
      await existingEmail.save();
    } else {
      const userCode = 'KC' + Date.now().toString().slice(-6);
      await User.create({ name, email, username, password: hashedPassword, userCode });
    }

    const otp = generateOTP();
    await storeOTP(email, otp);
    
    const emailSent = await sendEmailToQueue(email, otp);
    if (!emailSent) {
      console.warn('Email queue failed for registration, but user created. Email:', email);
    }

    return res.status(200).json({ 
      message: 'OTP sent to your email.',
      emailStatus: emailSent ? 'sent' : 'queued_with_issues'
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/login ─────────────────────────────────────────────────────────

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email });
    // Return the same message for non-existent user and wrong password to prevent user enumeration
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    if (!user.isVerified) {
      return res.status(403).json({ message: 'Account not verified. Complete registration first.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const otp = generateOTP();
    await storeOTP(email, otp);
    
    const emailSent = await sendEmailToQueue(email, otp);
    if (!emailSent) {
      console.warn('Email queue failed for login, but OTP stored. Email:', email);
    }

    return res.status(200).json({ 
      message: 'OTP sent to your email.',
      emailStatus: emailSent ? 'sent' : 'queued_with_issues'
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /auth/verify-otp ────────────────────────────────────────────────────

const verifyOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required.' });
    }

    await verifyOTP(email, otp);

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Mark verified on first-time registration flow
    if (!user.isVerified) {
      user.isVerified = true;
    }

    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    user.refreshToken = refreshToken;
    await user.save();

    res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);
    return res.status(200).json({ accessToken });
  } catch (err) {
    if (
      err.message === 'Invalid OTP.' ||
      err.message === 'OTP expired or not found.'
    ) {
      return res.status(401).json({ message: err.message });
    }
    if (err.message.startsWith('Maximum OTP attempts')) {
      return res.status(429).json({ message: err.message });
    }
    next(err);
  }
};

// ─── POST /auth/refresh-token ─────────────────────────────────────────────────

const refreshToken = async (req, res, next) => {
  try {
    const token = req.cookies.refreshToken;
    if (!token) {
      return res.status(401).json({ message: 'Refresh token missing.' });
    }

    const decoded = verifyRefreshToken(token);
    const user = await User.findById(decoded.id);

    if (!user || user.refreshToken !== token) {
      return res.status(403).json({ message: 'Invalid refresh token.' });
    }

    const newAccessToken = generateAccessToken(user._id);
    return res.status(200).json({ accessToken: newAccessToken });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(403).json({ message: 'Invalid or expired refresh token.' });
    }
    next(err);
  }
};

// ─── POST /auth/logout ────────────────────────────────────────────────────────

const logout = async (req, res, next) => {
  try {
    const token = req.cookies.refreshToken;

    if (token) {
      try {
        const decoded = verifyRefreshToken(token);
        await User.findByIdAndUpdate(decoded.id, { refreshToken: null });
      } catch {
        // Token already invalid — still clear the cookie
      }
    }

    res.clearCookie('refreshToken');
    return res.status(200).json({ message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
};

// ─── OAuth Authentication Methods ──────────────────────────────────────────

const oauthLogin = async (req, res, next) => {
  try {
    const { provider } = req.params;
    
    // Validate provider
    const supportedProviders = ['google', 'github'];
    if (!supportedProviders.includes(provider.toLowerCase())) {
      return res.status(400).json({ 
        message: `Unsupported OAuth provider: ${provider}. Supported providers: ${supportedProviders.join(', ')}` 
      });
    }

    // Generate and store CSRF protection state token
    const state = await generateStateToken();
    
    try {
      const authUrl = buildAuthUrl(provider, state);
      
      // Redirect user to OAuth provider
      return res.redirect(authUrl);
    } catch (configError) {
      console.error('OAuth configuration error:', configError.message);
      return res.status(500).json({ 
        message: `OAuth provider ${provider} is not properly configured` 
      });
    }
  } catch (error) {
    console.error('OAuth login error:', error);
    next(error);
  }
};

const oauthCallback = async (req, res, next) => {
  try {
    const { provider } = req.params;
    const { code, state, error: oauthError } = req.query;

    // Handle OAuth provider errors
    if (oauthError) {
      const errorMessages = {
        'access_denied': 'Authorization was cancelled',
        'invalid_request': 'Invalid OAuth request',
        'server_error': 'OAuth provider server error'
      };
      
      const message = errorMessages[oauthError] || 'OAuth authorization failed';
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=${encodeURIComponent(message)}`);
    }

    // Validate required parameters
    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=missing_authorization_code`);
    }

    if (!state) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=missing_state_parameter`);
    }

    // Validate state token for CSRF protection
    const isValidState = await validateStateToken(state);
    if (!isValidState) {
      console.warn('Invalid OAuth state token received:', state);
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=invalid_state_token`);
    }

    try {
      // Exchange authorization code for access token
      const tokenData = await exchangeCodeForToken(provider, code);
      
      // Fetch user information from OAuth provider
      const oauthUserData = await fetchUserInfo(provider, tokenData.access_token);
      
      // Normalize user data across different providers
      const userData = normalizeUserData(provider, oauthUserData);
      
      // Validate email presence
      if (!userData.email) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=no_email_provided`);
      }

      // Find or create user in database
      let user = await User.findOne({ email: userData.email });
      
      if (!user) {
        // Generate unique username for OAuth user
        const generateUsername = async (baseName) => {
          // Clean base name - remove spaces, special chars, keep only alphanumeric and underscore
          let cleanName = baseName.toLowerCase().replace(/[^a-zA-Z0-9_]/g, '').substring(0, 20);
          if (cleanName.length < 3) {
            cleanName = `user_${Math.random().toString(36).substring(2, 8)}`;
          }
          
          // Check if username exists and add suffix if needed
          let username = cleanName;
          let counter = 1;
          
          while (await User.findOne({ username })) {
            username = `${cleanName}${counter}`;
            counter++;
          }
          
          return username;
        };
        
        const generatedUsername = await generateUsername(userData.name || userData.displayName);
        
        // Create new user with OAuth provider data
        const userCode = 'KC' + Date.now().toString().slice(-6);
        user = await User.create({
          name: userData.name || userData.displayName,
          username: generatedUsername,
          email: userData.email,
          userCode,
          isVerified: true, // OAuth users are pre-verified by the provider
          oauthProviders: [{
            provider: userData.provider,
            providerId: userData.providerId,
            avatar: userData.avatar,
            displayName: userData.displayName,
          }],
        });
        
        console.log(`New user created via ${provider} OAuth:`, userData.email);
      } else {
        // Update existing user with OAuth provider if not already linked
        const existingProvider = user.oauthProviders?.find(
          p => p.provider === userData.provider && p.providerId === userData.providerId
        );
        
        if (!existingProvider) {
          // Link new OAuth provider to existing account
          user.oauthProviders = user.oauthProviders || [];
          user.oauthProviders.push({
            provider: userData.provider,
            providerId: userData.providerId,
            avatar: userData.avatar,
            displayName: userData.displayName,
          });
          
          console.log(`Linked ${provider} OAuth to existing user:`, userData.email);
        }
        
        // Ensure OAuth users are verified
        if (!user.isVerified) {
          user.isVerified = true;
          console.log(`Verified user via ${provider} OAuth:`, userData.email);
        }
        
        await user.save();
      }

      // Generate JWT tokens (same as existing system)
      const accessToken = generateAccessToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      // Store refresh token in database
      user.refreshToken = refreshToken;
      await user.save();

      // Set refresh token as httpOnly cookie (same as existing system)
      res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

      // Store user info for frontend
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      
      // Redirect to frontend with proper OAuth parameters
      // This matches what frontend login/register pages expect
      return res.redirect(
        `${frontendUrl}/login?success=true&token=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}&provider=${provider}&flow=oauth`
      );
      
    } catch (oauthProcessError) {
      console.error('OAuth processing error:', oauthProcessError);
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=oauth_processing_failed`);
    }
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=oauth_system_error`);
  }
};

// ─── GET /auth/users/search ──────────────────────────────────────────────────

const searchUsers = async (req, res, next) => {
  try {
    const { q, type = 'all' } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ message: 'Search query must be at least 2 characters.' });
    }

    const query = q.trim();
    let searchFilter = {};
    
    // Build search filter based on type
    switch (type) {
      case 'username':
        searchFilter = { username: { $regex: query, $options: 'i' } };
        break;
      case 'email':
        searchFilter = { email: { $regex: query, $options: 'i' } };
        break;
      case 'usercode':
        searchFilter = { userCode: { $regex: query, $options: 'i' } };
        break;
      default:
        // Search across username, email, and name
        searchFilter = {
          $or: [
            { username: { $regex: query, $options: 'i' } },
            { email: { $regex: query, $options: 'i' } },
            { name: { $regex: query, $options: 'i' } },
            { userCode: { $regex: query, $options: 'i' } }
          ]
        };
    }

    // Only search verified users
    searchFilter.isVerified = true;

    const users = await User.find(searchFilter)
      .select('name username email userCode _id')
      .limit(20)
      .lean();

    return res.status(200).json({ users });
  } catch (err) {
    next(err);
  }
};

// ─── GET /auth/users/me ──────────────────────────────────────────────────────

const getCurrentUser = async (req, res, next) => {
  try {
    const userId = req.userId; // From JWT middleware
    console.log('getCurrentUser called for userId:', userId, typeof userId);
    
    if (!userId) {
      console.error('No userId provided by auth middleware');
      return res.status(400).json({ message: 'Invalid user session' });
    }
    
    const user = await User.findById(userId)
      .select('name username email userCode _id isVerified')
      .lean();
    
    console.log('User found:', user ? 'yes' : 'no', user ? user.username : 'N/A');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Ensure userCode exists for existing users
    if (!user.userCode) {
      console.log('User missing userCode, generating one:', user.username);
      const generatedCode = 'KC' + Date.now().toString().slice(-6);
      await User.findByIdAndUpdate(userId, { userCode: generatedCode });
      user.userCode = generatedCode;
    }

    return res.status(200).json({ user });
  } catch (err) {
    console.error('getCurrentUser error:', err);
    next(err);
  }
};

module.exports = { 
  register, 
  login, 
  verifyOtp, 
  refreshToken, 
  logout,
  // OAuth methods
  oauthLogin,
  oauthCallback,
  // User search
  searchUsers,
  getCurrentUser
};
