const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const redis = require('redis');

let redisClient;

// Initialize Redis client
const initRedis = async () => {
  if (!redisClient) {
    redisClient = redis.createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => console.log('Redis Client Error', err));
    await redisClient.connect();
  }
  return redisClient;
};

/**
 * Send a new message
 * POST /messages
 */
const sendMessage = async (req, res) => {
  try {
    const { conversationId, content, messageType = 'text', metadata = {} } = req.body;
    const senderId = req.userId; // From JWT middleware
    
    if (!conversationId || !content) {
      return res.status(400).json({ 
        error: 'conversationId and content are required' 
      });
    }
    
    // Verify conversation exists and user is participant
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    if (!conversation.hasParticipant(senderId)) {
      return res.status(403).json({ error: 'Not authorized to send messages in this conversation' });
    }
    
    // Create message
    let expiresAt = null;
    if (conversation.isPremium && conversation.messageTTL) {
      expiresAt = new Date(Date.now() + (conversation.messageTTL * 1000));
    }
    
    const message = new Message({
      conversationId,
      senderId,
      content,
      messageType,
      metadata,
      expiresAt
    });
    
    await message.save();
    
    // Update conversation's last message
    conversation.lastMessage = {
      content: content.length > 100 ? content.substring(0, 100) + '...' : content,
      senderId,
      timestamp: message.createdAt,
      messageType
    };
    await conversation.save();
    
    // Populate sender info for response
    await message.populate('senderId', 'name email avatar');
    
    // Emit to Redis Pub/Sub for real-time delivery (skip if Redis not available)
    try {
      await initRedis();
      
      const eventData = {
        messageId: message._id,
        conversationId,
        senderId,
        content,
        messageType,
        timestamp: message.createdAt,
        senderInfo: {
          name: message.senderId.name,
          avatar: message.senderId.avatar
        }
      };
      
      if (conversation.type === 'direct') {
        // 1:1 chat - find receiver
        const receiverId = conversation.participants
          .find(p => p.userId.toString() !== senderId.toString())?.userId;
        
        if (receiverId) {
          eventData.receiverId = receiverId;
          await redisClient.publish('chat.message', JSON.stringify(eventData));
        }
      } else {
        // Group chat
        eventData.participantIds = conversation.activeParticipants
          .map(p => p.userId.toString())
          .filter(id => id !== senderId.toString());
        
        await redisClient.publish('chat.group.message', JSON.stringify(eventData));
      }
    } catch (redisError) {
      console.log('⚠️  Redis pub/sub disabled:', redisError.message);
    }
    
    res.status(201).json({
      message: 'Message sent successfully',
      data: {
        messageId: message._id,
        conversationId,
        content,
        messageType,
        timestamp: message.createdAt,
        status: message.status
      }
    });
    
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get messages for a conversation
 * GET /messages?conversationId=xxx&page=1&limit=50
 */
const getMessages = async (req, res) => {
  try {
    const { conversationId, page = 1, limit = 50 } = req.query;
    const userId = req.userId;
    
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }
    
    // Verify user is participant
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    if (!conversation.hasParticipant(userId)) {
      return res.status(403).json({ error: 'Not authorized to view this conversation' });
    }
    
    const skip = (page - 1) * limit;
    
    const messages = await Message.find({
      conversationId,
      deletedAt: null,
      $or: [
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } }
      ]
    })
    .populate('senderId', 'name email avatar')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
    
    const total = await Message.countDocuments({
      conversationId,
      deletedAt: null,
      $or: [
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } }
      ]
    });
    
    res.json({
      messages: messages.reverse(), // Most recent last for chat display
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get user's conversations
 * GET /conversations?page=1&limit=20
 */
const getConversations = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const userId = req.userId;
    const skip = (page - 1) * limit;
    
    const conversations = await Conversation.find({
      'participants.userId': userId,
      'participants.leftAt': null
    })
    .populate('participants.userId', 'name email avatar')
    .populate('lastMessage.senderId', 'name email avatar')
    .sort({ 'lastMessage.timestamp': -1, updatedAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
    
    const total = await Conversation.countDocuments({
      'participants.userId': userId,
      'participants.leftAt': null
    });
    
    // Transform data for frontend
    const conversationsData = conversations.map(conv => {
      const participant = conv.participants.find(p => 
        p.userId._id.toString() === userId.toString()
      );
      
      let displayInfo = {};
      
      if (conv.type === 'direct') {
        // For 1:1 chat, show other participant's info
        const otherParticipant = conv.participants.find(p => 
          p.userId._id.toString() !== userId.toString() && !p.leftAt
        );
        
        if (otherParticipant) {
          displayInfo = {
            name: otherParticipant.userId.name,
            avatar: otherParticipant.userId.avatar,
            isOnline: false // Will be populated by presence service
          };
        }
      } else {
        // Group chat
        displayInfo = {
          name: conv.name || 'Group Chat',
          avatar: conv.avatar,
          participantCount: conv.activeParticipants.length
        };
      }
      
      return {
        conversationId: conv._id,
        type: conv.type,
        displayInfo,
        lastMessage: conv.lastMessage ? {
          content: conv.lastMessage.content,
          timestamp: conv.lastMessage.timestamp,
          senderName: conv.lastMessage.senderId?.name,
          messageType: conv.lastMessage.messageType,
          isOwnMessage: conv.lastMessage.senderId?._id.toString() === userId.toString()
        } : null,
        unreadCount: 0, // TODO: Implement unread count
        isPremium: conv.isPremium,
        userRole: participant?.role,
        updatedAt: conv.updatedAt
      };
    });
    
    res.json({
      conversations: conversationsData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Create or find direct conversation
 * POST /conversations/direct
 */
const createDirectConversation = async (req, res) => {
  try {
    const { participantId } = req.body;
    const userId = req.userId;
    
    if (!participantId) {
      return res.status(400).json({ error: 'participantId is required' });
    }
    
    if (participantId === userId.toString()) {
      return res.status(400).json({ error: 'Cannot create conversation with yourself' });
    }
    
    // Check if conversation already exists
    const existingConversation = await Conversation.findOne({
      type: 'direct',
      'participants.userId': { $all: [userId, participantId] },
      'participants.leftAt': null
    });
    
    if (existingConversation) {
      return res.json({
        message: 'Conversation already exists',
        conversationId: existingConversation._id
      });
    }
    
    // Create new direct conversation
    const conversation = new Conversation({
      type: 'direct',
      participants: [
        { userId, role: 'member' },
        { userId: participantId, role: 'member' }
      ]
    });
    
    await conversation.save();
    
    res.status(201).json({
      message: 'Conversation created',
      conversationId: conversation._id
    });
    
  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Create group conversation
 * POST /conversations/group
 */
const createGroupConversation = async (req, res) => {
  try {
    const { name, description, participantIds = [] } = req.body;
    const userId = req.userId;
    
    if (!name) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    
    // Creator is owner, others are members
    const participants = [
      { userId, role: 'owner' },
      ...participantIds.map(id => ({ userId: id, role: 'member' }))
    ];
    
    const conversation = new Conversation({
      type: 'group',
      name,
      description,
      participants
    });
    
    await conversation.save();
    
    res.status(201).json({
      message: 'Group conversation created',
      conversationId: conversation._id
    });
    
  } catch (error) {
    console.error('Error creating group conversation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Update message status (delivered/read)
 * PATCH /messages/:messageId/status
 */
const updateMessageStatus = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { status } = req.body; // 'delivered' or 'read'
    const userId = req.userId;
    
    if (!['delivered', 'read'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // Verify user is participant in conversation
    const conversation = await Conversation.findById(message.conversationId);
    if (!conversation.hasParticipant(userId)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Only update status if it's progressing forward
    const statusOrder = { sent: 0, delivered: 1, read: 2 };
    if (statusOrder[status] > statusOrder[message.status]) {
      message.status = status;
      await message.save();
    }
    
    res.json({ message: 'Status updated', status: message.status });
    
  } catch (error) {
    console.error('Error updating message status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  sendMessage,
  getMessages,
  getConversations,
  createDirectConversation,
  createGroupConversation,
  updateMessageStatus
};