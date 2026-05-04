const mongoose = require('mongoose');

/**
 * FlaggedMessage — persistent record of every per-message moderation event
 * received from the sentiment-service Kafka pipeline. Powers the
 * "Top Toxic Members" analytics view and historical lookups.
 *
 * Written by the sentiment-results consumer in src/config/sentimentConsumer.js.
 * TTL: 90 days (auto-pruned by Mongo).
 */
const flaggedMessageSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true,
    index: true,
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  messageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null,
  },
  toxicity: {
    type: Number,
    required: true,
    min: 0,
    max: 1,
  },
  sentiment: {
    type: String,
    enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'],
    default: 'NEUTRAL',
  },
  flagged: {
    // True iff above the immediate-flag threshold (auto-mod hard hit).
    // We persist sub-threshold high-toxicity entries too (≥0.5) so the
    // "Top Toxic" ranking has volume to work with — but only `flagged`
    // entries trigger admin alerts.
    type: Boolean,
    default: false,
    index: true,
  },
  // Optional truncated content for evidence/audit (≤200 chars).
  // Disabled by default to keep DB lean & respect privacy; enable via env.
  contentSnippet: {
    type: String,
    default: null,
    maxlength: 200,
  },
}, {
  timestamps: true,
});

// Composite indexes for the two main aggregation queries.
flaggedMessageSchema.index({ conversationId: 1, createdAt: -1 });
flaggedMessageSchema.index({ conversationId: 1, senderId: 1, createdAt: -1 });

// 90-day TTL — keeps storage bounded and limits long-lived rep damage.
flaggedMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model('FlaggedMessage', flaggedMessageSchema);
