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
  regenerateInviteCode
} = require('../controllers/chatController');

// Apply authentication to all routes
router.use(authenticateToken);

// Message routes
router.post('/messages', sendMessage);
router.get('/messages', getMessages);
router.patch('/messages/:messageId/status', updateMessageStatus);

// Conversation routes
router.get('/conversations', getConversations);
router.post('/conversations/direct', createDirectConversation);
router.post('/conversations/group', createGroupConversation);

// Group join routes
router.post('/groups/join', joinGroupByCode);
router.get('/groups/preview/:code', previewGroupByCode);
router.get('/groups/:groupId/qr', generateGroupQR);
router.post('/groups/:groupId/regenerate-code', regenerateInviteCode);

module.exports = router;