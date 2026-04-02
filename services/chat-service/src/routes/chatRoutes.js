const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  sendMessage,
  getMessages,
  getConversations,
  createDirectConversation,
  createGroupConversation,
  updateMessageStatus
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

module.exports = router;