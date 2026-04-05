const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: [/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores']
    },
    userCode: {
      type: String,
      unique: true,
      default: function() {
        return 'KC' + Date.now().toString().slice(-6);
      }
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: function() {
        // Password is required only if user doesn't have OAuth providers
        return !this.oauthProviders || this.oauthProviders.length === 0;
      },
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    refreshToken: {
      type: String,
      default: null,
    },
    oauthProviders: [{
      provider: { 
        type: String, 
        enum: ['google', 'github', 'facebook'],
        required: true
      },
      providerId: { 
        type: String, 
        required: true 
      },
      avatar: { 
        type: String 
      },
      displayName: {
        type: String
      },
      createdAt: { 
        type: Date, 
        default: Date.now 
      }
    }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
