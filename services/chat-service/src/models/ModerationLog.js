const mongoose = require('mongoose');

const moderationLogSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true,
    index: true
  },
  action: {
    type: String,
    enum: ['lock', 'unlock', 'reset'],
    required: true
  },
  triggeredBy: {
    type: String,
    enum: ['auto', 'manual'],
    required: true
  },
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  moderationScore: {
    type: Number,
    default: null
  },
  duration: {
    type: Number,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Index for querying recent history per group
moderationLogSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('ModerationLog', moderationLogSchema);
