# OAuth Setup Guide for Konnect

This guide explains how to set up OAuth authentication with Google and GitHub alongside your existing JWT authentication system.

## 🚀 Quick Start

1. **Install dependencies:**
   ```bash
   cd Konnect/services/auth-service
   npm install axios
   ```

2. **Set up environment variables:**
   Copy `.env.example` to `.env` and configure OAuth credentials:
   ```env
   # Google OAuth
   GOOGLE_CLIENT_ID=your_google_client_id_here
   GOOGLE_CLIENT_SECRET=your_google_client_secret_here
   
   # GitHub OAuth
   GITHUB_CLIENT_ID=your_github_client_id_here
   GITHUB_CLIENT_SECRET=your_github_client_secret_here
   
   # Frontend URL
   FRONTEND_URL=http://localhost:3000
   ```

3. **Start your services:**
   ```bash
   # Auth service
   cd Konnect/services/auth-service
   npm start
   
   # Frontend
   cd frontend
   npm run dev
   ```

## 🔧 OAuth Provider Setup

### Google OAuth Setup

1. **Go to Google Cloud Console:**
   - Visit [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing

2. **Enable Google+ API:**
   - Go to "APIs & Services" > "Library"
   - Search for "Google+ API" and enable it

3. **Create OAuth 2.0 Credentials:**
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth 2.0 Client IDs"
   - Choose "Web application"
   - Add authorized redirect URIs:
     - `http://localhost:3002/auth/google/callback`
     - `https://yourdomain.com/auth/google/callback` (for production)

4. **Copy credentials to `.env`:**
   ```env
   GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your_client_secret
   ```

### GitHub OAuth Setup

1. **Go to GitHub Developer Settings:**
   - Visit [GitHub Developer Settings](https://github.com/settings/developers)
   - Click "New OAuth App"

2. **Configure OAuth App:**
   - Application name: `Konnect`
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3002/auth/github/callback`

3. **Copy credentials to `.env`:**
   ```env
   GITHUB_CLIENT_ID=your_github_client_id
   GITHUB_CLIENT_SECRET=your_github_client_secret
   ```

## 📋 How It Works

### Hybrid Authentication System

Your implementation now supports **two authentication flows** that work seamlessly together:

#### Traditional JWT Flow (Unchanged)
```
User → Register → OTP → Verify → JWT Tokens → Dashboard
User → Login → OTP → Verify → JWT Tokens → Dashboard
```

#### New OAuth Flow
```
User → Click OAuth Button → Provider Auth → JWT Tokens → Dashboard
```

### Key Features

✅ **Existing JWT auth preserved** - No changes to current flows
✅ **Same token system** - OAuth generates identical JWT tokens
✅ **Unified user database** - OAuth users stored in same User model
✅ **Account linking** - Users can link multiple OAuth providers
✅ **Pre-verified** - OAuth users skip email verification

## 🛡️ Security Features

- **CSRF Protection:** State parameter prevents request forgery
- **httpOnly Cookies:** Refresh tokens stored securely
- **Token Validation:** Same JWT validation for all flows
- **Provider Verification:** Users verified by OAuth provider

## 📱 Frontend Integration

### OAuth Buttons Added To:
- **Registration page** (`/register`) - "Or continue with" section
- **Login page** (`/login`) - Alternative login options
- **Dashboard** - Handles OAuth redirects with tokens

### Error Handling:
- OAuth errors displayed on login page
- Graceful fallback for missing credentials
- User-friendly error messages

## 🔄 API Endpoints

New OAuth routes added to your auth service:

```
GET /auth/oauth/:provider     # Initiate OAuth flow
GET /auth/:provider/callback  # Handle OAuth callback

# Supported providers: google, github
```

Examples:
```
http://localhost:3002/auth/oauth/google
http://localhost:3002/auth/oauth/github
```

## 🗄️ Database Schema

OAuth provider information is stored in the User model:

```javascript
{
  name: "John Doe",
  email: "john@example.com",
  isVerified: true,
  oauthProviders: [{
    provider: "google",           // or "github"
    providerId: "123456789",      // OAuth provider's user ID
    avatar: "https://...",        // Profile picture URL
    displayName: "John Doe",      // Display name from provider
    createdAt: "2024-03-30T..."   // When OAuth was linked
  }]
}
```

## 🚀 Production Deployment

1. **Update redirect URIs** in OAuth provider settings:
   ```
   https://yourdomain.com/auth/google/callback
   https://yourdomain.com/auth/github/callback
   ```

2. **Update environment variables:**
   ```env
   FRONTEND_URL=https://yourdomain.com
   GOOGLE_REDIRECT_URI=https://yourdomain.com/auth/google/callback
   GITHUB_REDIRECT_URI=https://yourdomain.com/auth/github/callback
   ```

3. **Enable secure cookies:**
   ```env
   NODE_ENV=production
   ```

## ✨ Adding More Providers

To add providers like Facebook, Twitter, etc:

1. **Add provider config** in `src/config/oauth.js`
2. **Update normalization** in `src/services/oauthService.js`  
3. **Add frontend button** in login/register pages
4. **Update User model** enum for new providers

## 🔍 Testing OAuth

1. **Start services:**
   ```bash
   # Terminal 1: Auth Service
   cd Konnect/services/auth-service && npm start
   
   # Terminal 2: Frontend  
   cd frontend && npm run dev
   ```

2. **Test OAuth flow:**
   - Visit `http://localhost:3000/login`
   - Click "Google" or "GitHub" button
   - Complete OAuth flow
   - Verify redirect to dashboard with token

3. **Test account linking:**
   - Create account with traditional flow
   - Login and link OAuth provider
   - Verify both methods work for same user

## 🛠️ Troubleshooting

### Common Issues:

1. **"OAuth provider not configured"**
   - Check `.env` file has OAuth credentials
   - Restart auth service after adding credentials

2. **"Redirect URI mismatch"**
   - Verify callback URLs match in OAuth provider settings
   - Check `http` vs `https` and port numbers

3. **"No email provided"**
   - GitHub users might have private emails
   - Request email scope in OAuth config

4. **"Invalid token"**
   - Check JWT secrets are same for OAuth and traditional flows
   - Verify token expiration settings

Your OAuth implementation is now ready! Users can sign in with Google/GitHub or use the traditional email/password flow - both generate the same JWT tokens and provide the same user experience. 🎉