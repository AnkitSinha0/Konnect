const mongoose = require('mongoose');
const crypto = require('crypto');

const conversationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['direct', 'group'],
    required: true
  },
  participants: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    role: {
      type: String,
      enum: ['member', 'moderator', 'admin', 'owner'],
      default: 'member'
    },
    isMuted: {
      type: Boolean,
      default: false
    },
    mutedUntil: {
      type: Date,
      default: null
    },
    isBanned: {
      type: Boolean,
      default: false
    },
    leftAt: {
      type: Date,
      default: null
    }
  }],
  // Group chat specific fields
  name: {
    type: String,
    maxlength: 100
  },
  description: {
    type: String,
    maxlength: 500
  },
  avatar: {
    type: String
  },
  // Group invite system
  inviteCode: {
    type: String,
    unique: true,
    sparse: true, // Only for groups
    default: function() {
      if (this.type === 'group') {
        return 'KG' + crypto.randomBytes(6).toString('hex');
      }
      return undefined;
    }
  },
  inviteLink: {
    type: String
  },
  allowInvites: {
    type: Boolean,
    default: true
  },
  // Last message info for conversation list
  lastMessage: {
    content: String,
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    timestamp: Date,
    messageType: {
      type: String,
      enum: ['text', 'image', 'file', 'system'],
      default: 'text'
    }
  },
  // Premium features
  isPremium: {
    type: Boolean,
    default: false
  },
  messageTTL: {
    type: Number, // in seconds
    default: null
  },
  // Settings
  settings: {
    allowFileSharing: {
      type: Boolean,
      default: true
    },
    maxFileSize: {
      type: Number,
      default: 10485760 // 10MB
    },
    allowedMimeTypes: [String]
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
conversationSchema.index({ 'participants.userId': 1 });
conversationSchema.index({ type: 1, 'participants.userId': 1 });
conversationSchema.index({ 'lastMessage.timestamp': -1 });

// Virtual for active participants
conversationSchema.virtual('activeParticipants').get(function() {
  return this.participants.filter(p => !p.leftAt);
});

// Method to check if user is participant
conversationSchema.methods.hasParticipant = function(userId) {
  return this.participants.some(p => 
    p.userId.toString() === userId.toString() && !p.leftAt && !p.isBanned
  );
};

// Method to get a participant's role
conversationSchema.methods.getUserRole = function(userId) {
  const p = this.participants.find(
    p => p.userId.toString() === userId.toString() && !p.leftAt && !p.isBanned
  );
  return p ? p.role : null;
};

// Role hierarchy helper
conversationSchema.statics.ROLE_RANK = { member: 0, moderator: 1, admin: 2, owner: 3 };

conversationSchema.statics.canManage = function(actorRole, targetRole) {
  const ranks = this.ROLE_RANK;
  return (ranks[actorRole] || 0) > (ranks[targetRole] || 0);
};

// Method to add participant
conversationSchema.methods.addParticipant = function(userId, role = 'member') {
  // Check if user was previously in conversation
  const existingParticipant = this.participants.find(p => 
    p.userId.toString() === userId.toString()
  );

  // Prevent banned users from being re-added
  if (existingParticipant && existingParticipant.isBanned) {
    return false;
  }
  
  if (existingParticipant && existingParticipant.leftAt) {
    // Rejoin conversation
    existingParticipant.leftAt = null;
    existingParticipant.joinedAt = new Date();
    existingParticipant.role = role;
  } else if (!existingParticipant) {
    // New participant
    this.participants.push({
      userId,
      role,
      joinedAt: new Date()
    });
  }
};

// Method to remove participant
conversationSchema.methods.removeParticipant = function(userId) {
  const participant = this.participants.find(p => 
    p.userId.toString() === userId.toString() && !p.leftAt
  );
  
  if (participant) {
    participant.leftAt = new Date();
  }
};

module.exports = mongoose.model('Conversation', conversationSchema);