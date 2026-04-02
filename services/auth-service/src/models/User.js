const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
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
