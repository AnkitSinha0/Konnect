const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  sendMessage,
  getMessages,
  getConversations,
  createDirectConversation,
  createGroupConversation,
  updateMessageStatus,
  joinGroupByCode,
  previewGroupByCode,
  generateGroupQR,
  regenerateInviteCode,
  getGroupMembers,
  updateMemberRole,
  removeMember,
  muteMember,
  banMember,
  unbanMember,
  leaveGroup,
  deleteMessage,
  deleteGroup,
  getModerationStats,
  getModerationHistory,
  moderationLockGroup,
  moderationUnlockGroup,
  moderationResetWindow,
  getTopToxicUsers,
  auditModerationExport
} = require('../controllers/chatController');

// Public routes (no auth required)
router.get('/groups/preview/:code', previewGroupByCode);

// Apply authentication to all routes below
router.use(authenticateToken);

// Message routes
router.post('/messages', sendMessage);
router.get('/messages', getMessages);
router.patch('/messages/:messageId/status', updateMessageStatus);
router.delete('/messages/:messageId', deleteMessage);

// Conversation routes
router.get('/conversations', getConversations);
router.post('/conversations/direct', createDirectConversation);
router.post('/conversations/group', createGroupConversation);

// Group join / invite routes
router.post('/groups/join', joinGroupByCode);
router.get('/groups/:groupId/qr', generateGroupQR);
router.post('/groups/:groupId/regenerate-code', regenerateInviteCode);

// Group management routes
router.delete('/groups/:groupId', deleteGroup);
router.get('/groups/:groupId/members', getGroupMembers);
router.post('/groups/:groupId/leave', leaveGroup);
router.patch('/groups/:groupId/members/:memberId/role', updateMemberRole);
router.delete('/groups/:groupId/members/:memberId', removeMember);
router.patch('/groups/:groupId/members/:memberId/mute', muteMember);
router.patch('/groups/:groupId/members/:memberId/ban', banMember);
router.patch('/groups/:groupId/members/:memberId/unban', unbanMember);

// Moderation routes
router.get('/groups/:groupId/moderation/stats', getModerationStats);
router.get('/groups/:groupId/moderation/history', getModerationHistory);
router.get('/groups/:groupId/moderation/top-toxic', getTopToxicUsers);
router.post('/groups/:groupId/moderation/lock', moderationLockGroup);
router.post('/groups/:groupId/moderation/unlock', moderationUnlockGroup);
router.post('/groups/:groupId/moderation/reset', moderationResetWindow);
router.post('/groups/:groupId/moderation/audit-export', auditModerationExport);

module.exports = router;