const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const ModerationLog = require('../models/ModerationLog');
const FlaggedMessage = require('../models/FlaggedMessage');
const { publishMessage: kafkaPublish } = require('../config/kafka');

// Redis client will be passed from server.js or imported from a shared module
let redisClient;

// Function to set Redis client from server.js
const setRedisClient = (client) => {
  redisClient = client;
};

/**
 * Send a new message
 * POST /messages
 */
const sendMessage = async (req, res) => {
  try {
    const { conversationId, content, messageType = 'text', metadata = {}, tempId } = req.body;
    const senderId = req.userId; // From JWT middleware
    
    if (!conversationId || !content) {
      return res.status(400).json({ 
        error: 'conversationId and content are required' 
      });
    }

    // Idempotency: if a tempId is provided, dedup duplicate sends within 60s
    // (prevents double-clicks, socket retries, multi-tab broadcasts)
    if (tempId && redisClient) {
      try {
        const idemKey = `msg:idem:${senderId}:${tempId}`;
        const existingId = await redisClient.get(idemKey);
        if (existingId) {
          console.log(`♻️  Duplicate send ignored (tempId=${tempId}, msgId=${existingId})`);
          return res.status(200).json({
            message: 'Duplicate ignored',
            data: { messageId: existingId, conversationId, content, messageType, duplicate: true }
          });
        }
      } catch (idemErr) {
        console.warn('Idempotency check failed (continuing):', idemErr.message);
      }
    }

    // Verify conversation exists and user is participant
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    if (!conversation.hasParticipant(senderId)) {
      return res.status(403).json({ error: 'Not authorized to send messages in this conversation' });
    }

    // Enforce mute: check if sender is currently muted
    if (conversation.type === 'group') {
      const senderParticipant = conversation.participants.find(
        p => p.userId.toString() === senderId.toString() && !p.leftAt
      );
      if (senderParticipant?.isMuted) {
        if (!senderParticipant.mutedUntil || senderParticipant.mutedUntil > new Date()) {
          return res.status(403).json({ error: 'You are muted in this group' });
        }
        // Mute has expired — clear it
        senderParticipant.isMuted = false;
        senderParticipant.mutedUntil = null;
        await conversation.save();
      }

      // Enforce moderation lock: only moderator+ can send when group is locked
      if (redisClient) {
        const lockKey = `sentiment:lock:${conversationId}`;
        const isLocked = await redisClient.exists(lockKey) === 1;
        if (isLocked) {
          const senderRole = conversation.getUserRole(senderId);
          if (!['moderator', 'admin', 'owner'].includes(senderRole)) {
            return res.status(403).json({ error: 'Group is locked by moderation. Only moderators can send messages.' });
          }
        }
      }
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

    // Record idempotency key now that the message has been persisted
    if (tempId && redisClient) {
      try {
        await redisClient.set(`msg:idem:${senderId}:${tempId}`, message._id.toString(), { EX: 60 });
      } catch (idemErr) {
        console.warn('Idempotency set failed:', idemErr.message);
      }
    }
    
    // Update conversation's last message
    conversation.lastMessage = {
      content: content.length > 100 ? content.substring(0, 100) + '...' : content,
      senderId,
      timestamp: message.createdAt,
      messageType
    };
    await conversation.save();
    
    // Emit to Redis Pub/Sub for real-time delivery
    try {
      // Use global redisClient from server.js
      if (!redisClient) {
        const redis = require('redis');
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.log('Redis Client Error', err));
        await redisClient.connect();
      }
      
      const eventData = {
        messageId: message._id,
        conversationId,
        senderId,
        content,
        messageType,
        timestamp: message.createdAt,
        senderInfo: {
          name: req.userName || req.userEmail || null,
          avatar: null
        }
      };

      // If JWT didn't carry the name (legacy tokens), look it up from DB
      // so the WebSocket payload never falls back to an ObjectId.
      if (!eventData.senderInfo.name) {
        try {
          const sender = await User.findById(senderId).select('name username email').lean();
          eventData.senderInfo.name = sender?.name || sender?.username || sender?.email || 'Unknown';
        } catch (lookupErr) {
          console.warn('Sender name lookup failed:', lookupErr.message);
          eventData.senderInfo.name = 'Unknown';
        }
      }
      
      if (conversation.type === 'direct') {
        // 1:1 chat - find receiver
        const receiverId = conversation.participants
          .find(p => p.userId.toString() !== senderId.toString())?.userId;
        
        if (receiverId) {
          eventData.receiverId = receiverId;
          await redisClient.publish('chat.message', JSON.stringify(eventData));
          console.log(`📡 Published 1:1 message to Redis: ${senderId} -> ${receiverId}`);
        }
      } else {
        // Group chat
        eventData.participantIds = conversation.activeParticipants
          .map(p => p.userId.toString())
          .filter(id => id !== senderId.toString());
        
        await redisClient.publish('chat.group.message', JSON.stringify(eventData));
        console.log(`📡 Published group message to Redis: conversation ${conversationId}`);
      }
    } catch (redisError) {
      console.error('❌ Redis pub/sub failed:', redisError.message);
      // Continue anyway - message is still saved to database
    }

    // Publish to Kafka for sentiment analysis pipeline (non-blocking)
    try {
      await kafkaPublish({
        messageId: message._id.toString(),
        conversationId,
        senderId,
        content,
        messageType,
        timestamp: message.createdAt,
      });
    } catch (kafkaError) {
      console.error('⚠️  Kafka publish failed:', kafkaError.message);
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

    // For group chats, only show messages after the user's joinedAt timestamp
    const messageQuery = {
      conversationId,
      deletedAt: null,
      $or: [
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } }
      ]
    };

    if (conversation.type === 'group') {
      const participant = conversation.participants.find(
        p => p.userId.toString() === userId.toString() && !p.leftAt && !p.isBanned
      );
      if (participant && participant.joinedAt) {
        messageQuery.createdAt = { $gte: participant.joinedAt };
      }
    }
    
    const messages = await Message.find(messageQuery)
    .populate({ path: 'senderId', select: 'name email avatar', model: User })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
    
    const total = await Message.countDocuments(messageQuery);

    // Build a set of user IDs who have left or been banned from this conversation
    // so the client can render their messages as "former member".
    const leftUserIds = new Set(
      conversation.participants
        .filter(p => p.leftAt || p.isBanned)
        .map(p => p.userId.toString())
    );

    const messagesWithStatus = messages.reverse().map(m => {
      const obj = m.toObject();
      const senderIdStr = (obj.senderId?._id || obj.senderId)?.toString();
      obj.senderLeft = senderIdStr ? leftUserIds.has(senderIdStr) : false;
      return obj;
    });

    res.json({
      messages: messagesWithStatus, // Most recent last for chat display
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
    
    // Include conversations where user is active OR banned (so banned users still see the group)
    const conversations = await Conversation.find({
      participants: {
        $elemMatch: {
          userId: userId,
          $or: [
            { leftAt: null },
            { isBanned: true }
          ]
        }
      }
    })
    .populate({ path: 'participants.userId', select: 'name email avatar', model: User })
    .populate({ path: 'lastMessage.senderId', select: 'name email avatar', model: User })
    .sort({ 'lastMessage.timestamp': -1, updatedAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
    
    const total = await Conversation.countDocuments({
      participants: {
        $elemMatch: {
          userId: userId,
          $or: [
            { leftAt: null },
            { isBanned: true }
          ]
        }
      }
    });
    
    // Transform data for frontend
    const conversationsData = conversations.map(conv => {
      const participant = conv.participants.find(p => 
        p.userId && p.userId._id && p.userId._id.toString() === userId.toString()
      );
      
      const isBanned = participant?.isBanned === true;
      
      let displayInfo = {};
      
      if (conv.type === 'direct') {
        // For 1:1 chat, show other participant's info
        const otherParticipant = conv.participants.find(p => 
          p.userId && p.userId._id && p.userId._id.toString() !== userId.toString() && !p.leftAt
        );
        
        if (otherParticipant) {
          displayInfo = {
            name: otherParticipant.userId.name,
            avatar: otherParticipant.userId.avatar,
            otherUserId: otherParticipant.userId._id?.toString(),
            isOnline: false // Will be populated by presence service
          };
        }
      } else {
        // Group chat
        displayInfo = {
          name: conv.name || 'Group Chat',
          avatar: conv.avatar,
          participantCount: conv.activeParticipants.length,
          participantIds: conv.activeParticipants
            .map(p => p.userId?._id?.toString())
            .filter(Boolean)
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
          isOwnMessage: conv.lastMessage.senderId?._id?.toString() === userId.toString()
        } : null,
        unreadCount: 0, // TODO: Implement unread count
        isPremium: conv.isPremium,
        isBanned,
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

/**
 * Join a group by invite code
 * POST /groups/join
 */
const joinGroupByCode = async (req, res) => {
  try {
    const { inviteCode } = req.body;
    const userId = req.userId;
    
    if (!inviteCode) {
      return res.status(400).json({ error: 'Invite code is required' });
    }
    
    // Find conversation by invite code
    const conversation = await Conversation.findOne({ 
      inviteCode,
      type: 'group',
      allowInvites: true
    });
    
    if (!conversation) {
      return res.status(404).json({ error: 'Invalid invite code or group not found' });
    }
    
    // Check if user is banned from this group
    const bannedParticipant = conversation.participants.find(
      p => p.userId.toString() === userId.toString() && p.isBanned
    );
    if (bannedParticipant) {
      return res.status(403).json({ error: 'You are banned from this group' });
    }

    // Check if user is already a participant
    const existingParticipant = conversation.participants.find(
      p => p.userId.toString() === userId.toString() && !p.leftAt
    );
    
    if (existingParticipant) {
      return res.status(409).json({ error: 'You are already a member of this group' });
    }
    
    // Add user to group
    conversation.participants.push({
      userId,
      role: 'member',
      joinedAt: new Date()
    });
    
    await conversation.save();
    await conversation.populate({ path: 'participants.userId', select: 'name email username', model: User });

    // Get user's name for system message
    const joiningUser = await User.findById(userId).select('name username');
    const joinerName = joiningUser?.name || joiningUser?.username || 'Someone';
    
    // Create join message
    const joinMessage = new Message({
      conversationId: conversation._id,
      senderId: userId,
      content: `${joinerName} joined the group`,
      messageType: 'system'
    });
    
    await joinMessage.save();
    
    // Emit join event via Redis
    try {
      if (!redisClient) {
        const redis = require('redis');
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.log('Redis Client Error', err));
        await redisClient.connect();
      }
      const eventData = {
        messageId: joinMessage._id,
        conversationId: conversation._id,
        senderId: userId,
        content: joinMessage.content,
        messageType: 'system',
        timestamp: joinMessage.createdAt
      };
      await redisClient.publish('chat.group.message', JSON.stringify(eventData));
    } catch (redisError) {
      console.warn('Redis publish failed for group join:', redisError);
    }
    
    res.status(200).json({ 
      message: 'Successfully joined group',
      conversation: {
        id: conversation._id,
        name: conversation.name,
        type: conversation.type,
        avatar: conversation.avatar,
        participants: conversation.participants.length,
        lastMessage: joinMessage.content,
        lastTime: joinMessage.createdAt
      }
    });
    
  } catch (error) {
    console.error('Error joining group:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get group info by invite code (for preview)
 * GET /groups/preview/:code
 */
const previewGroupByCode = async (req, res) => {
  try {
    const { code } = req.params;
    
    const conversation = await Conversation.findOne({ 
      inviteCode: code,
      type: 'group',
      allowInvites: true
    }).select('name description avatar participants createdAt');
    
    if (!conversation) {
      return res.status(404).json({ error: 'Invalid invite code or group not found' });
    }
    
    res.status(200).json({
      group: {
        id: conversation._id,
        name: conversation.name,
        description: conversation.description,
        avatar: conversation.avatar,
        memberCount: conversation.activeParticipants.length,
        createdAt: conversation.createdAt
      }
    });
    
  } catch (error) {
    console.error('Error previewing group:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Generate QR code for group invite
 * GET /groups/:groupId/qr
 */
const generateGroupQR = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.userId;
    
    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }
    
    // Check if user is a participant
    if (!conversation.hasParticipant(userId)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (!conversation.inviteCode) {
      return res.status(400).json({ error: 'Group has no invite code' });
    }
    
    const QRCode = require('qrcode');
    const inviteLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/join/${conversation.inviteCode}`;
    
    const qrDataURL = await QRCode.toDataURL(inviteLink);
    
    res.status(200).json({
      qrCode: qrDataURL,
      inviteCode: conversation.inviteCode,
      inviteLink
    });
    
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Regenerate group invite code
 * POST /groups/:groupId/regenerate-code
 */
const regenerateInviteCode = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.userId;
    
    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }
    
    // Check if user is admin or owner
    const participant = conversation.participants.find(
      p => p.userId.toString() === userId.toString() && !p.leftAt
    );
    
    if (!participant || !['admin', 'owner'].includes(participant.role)) {
      return res.status(403).json({ error: 'Only group admins can regenerate invite codes' });
    }
    
    // Generate new invite code
    conversation.inviteCode = 'KG' + require('crypto').randomBytes(6).toString('hex');
    await conversation.save();
    
    res.status(200).json({
      message: 'Invite code regenerated',
      inviteCode: conversation.inviteCode
    });
    
  } catch (error) {
    console.error('Error regenerating invite code:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get group members with roles
 * GET /groups/:groupId/members
 */
const getGroupMembers = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Allow banned users to view members (they can still see the group)
    const userParticipant = conversation.participants.find(
      p => p.userId.toString() === userId.toString()
    );
    if (!userParticipant || (userParticipant.leftAt && !userParticipant.isBanned)) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    await conversation.populate({ path: 'participants.userId', select: 'name username email avatar', model: User });

    const members = conversation.participants
      .filter(p => !p.leftAt && !p.isBanned && p.userId)
      .map(p => ({
        userId: p.userId._id,
        name: p.userId.name,
        username: p.userId.username,
        avatar: p.userId.avatar,
        role: p.role,
        joinedAt: p.joinedAt,
        isMuted: p.isMuted,
        mutedUntil: p.mutedUntil
      }));

    // Include banned members list for admin/owner
    const callerRole = userParticipant.role;
    let bannedMembers = [];
    if (['admin', 'owner'].includes(callerRole)) {
      bannedMembers = conversation.participants
        .filter(p => p.isBanned && p.userId)
        .map(p => ({
          userId: p.userId._id,
          name: p.userId.name,
          username: p.userId.username,
          avatar: p.userId.avatar,
          bannedAt: p.leftAt
        }));
    }

    res.json({ members, bannedMembers });
  } catch (error) {
    console.error('Error fetching group members:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Update a member's role (promote / demote)
 * PATCH /groups/:groupId/members/:memberId/role
 * Body: { role: 'member' | 'moderator' | 'admin' }
 *
 * Permission rules:
 *  - owner can set anyone (below owner) to any role below owner
 *  - admin can promote/demote moderators only
 */
const updateMemberRole = async (req, res) => {
  try {
    const { groupId, memberId } = req.params;
    const { role: newRole } = req.body;
    const actorId = req.userId;

    const ALLOWED_ROLES = ['member', 'moderator', 'admin'];
    if (!ALLOWED_ROLES.includes(newRole)) {
      return res.status(400).json({ error: 'Invalid role. Allowed: member, moderator, admin' });
    }

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!actorRole) return res.status(403).json({ error: 'Not a member of this group' });

    const targetParticipant = conversation.participants.find(
      p => p.userId.toString() === memberId && !p.leftAt && !p.isBanned
    );
    if (!targetParticipant) return res.status(404).json({ error: 'Member not found' });

    const targetRole = targetParticipant.role;
    const RANK = Conversation.ROLE_RANK;

    // Cannot change the owner's role
    if (targetRole === 'owner') {
      return res.status(403).json({ error: 'Cannot change the owner\'s role' });
    }

    // Actor must outrank the target's current role AND the new role
    if (RANK[actorRole] <= RANK[targetRole] || RANK[actorRole] <= RANK[newRole]) {
      return res.status(403).json({ error: 'Insufficient permissions to assign this role' });
    }

    targetParticipant.role = newRole;
    await conversation.save();

    res.json({ message: `Role updated to ${newRole}`, userId: memberId, role: newRole });
  } catch (error) {
    console.error('Error updating member role:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Remove (kick) a member from the group
 * DELETE /groups/:groupId/members/:memberId
 * Admins can remove members/moderators; owner can remove anyone
 */
const removeMember = async (req, res) => {
  try {
    const { groupId, memberId } = req.params;
    const actorId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!actorRole) return res.status(403).json({ error: 'Not a member of this group' });

    const targetParticipant = conversation.participants.find(
      p => p.userId.toString() === memberId && !p.leftAt && !p.isBanned
    );
    if (!targetParticipant) return res.status(404).json({ error: 'Member not found' });

    const targetRole = targetParticipant.role;
    if (!Conversation.canManage(actorRole, targetRole)) {
      return res.status(403).json({ error: 'Insufficient permissions to remove this member' });
    }

    targetParticipant.leftAt = new Date();
    await conversation.save();

    // Get target user's name for system message
    const targetUser = await User.findById(memberId).select('name username');
    const targetName = targetUser?.name || targetUser?.username || 'A member';

    // Create system message
    const systemMessage = new Message({
      conversationId: groupId,
      senderId: actorId,
      content: `${targetName} was removed from the group`,
      messageType: 'system'
    });
    await systemMessage.save();

    // Publish removal event via Redis
    try {
      if (!redisClient) {
        const redis = require('redis');
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.log('Redis Client Error', err));
        await redisClient.connect();
      }
      // Notify the removed user
      await redisClient.publish('chat.member.removed', JSON.stringify({
        userId: memberId,
        conversationId: groupId
      }));
      // Broadcast system message to remaining members
      await redisClient.publish('chat.group.message', JSON.stringify({
        messageId: systemMessage._id,
        conversationId: groupId,
        senderId: actorId,
        content: systemMessage.content,
        messageType: 'system',
        timestamp: systemMessage.createdAt
      }));
    } catch (redisError) {
      console.error('Redis publish failed for remove event:', redisError.message);
    }

    res.json({ message: 'Member removed from group' });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Mute a member temporarily
 * PATCH /groups/:groupId/members/:memberId/mute
 * Body: { durationMinutes: number } — 0 to unmute
 * Admin and moderator can mute members; admin can mute moderators
 */
const muteMember = async (req, res) => {
  try {
    const { groupId, memberId } = req.params;
    const { durationMinutes = 10 } = req.body;
    const actorId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!['moderator', 'admin', 'owner'].includes(actorRole)) {
      return res.status(403).json({ error: 'Only moderators and above can mute members' });
    }

    const targetParticipant = conversation.participants.find(
      p => p.userId.toString() === memberId && !p.leftAt && !p.isBanned
    );
    if (!targetParticipant) return res.status(404).json({ error: 'Member not found' });

    if (!Conversation.canManage(actorRole, targetParticipant.role)) {
      return res.status(403).json({ error: 'Insufficient permissions to mute this member' });
    }

    if (durationMinutes <= 0) {
      targetParticipant.isMuted = false;
      targetParticipant.mutedUntil = null;
    } else {
      targetParticipant.isMuted = true;
      targetParticipant.mutedUntil = new Date(Date.now() + durationMinutes * 60 * 1000);
    }

    await conversation.save();

    // Notify gateway to update in-memory mute state
    try {
      if (!redisClient) {
        const redis = require('redis');
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.log('Redis Client Error', err));
        await redisClient.connect();
      }
      if (durationMinutes <= 0) {
        await redisClient.publish('chat.member.unmuted', JSON.stringify({ userId: memberId, conversationId: groupId }));
      } else {
        await redisClient.publish('chat.member.muted', JSON.stringify({
          userId: memberId,
          conversationId: groupId,
          mutedUntil: targetParticipant.mutedUntil,
          durationMinutes
        }));
      }
    } catch (redisError) {
      console.error('Redis publish failed for mute event:', redisError.message);
    }

    const action = durationMinutes <= 0 ? 'unmuted' : `muted for ${durationMinutes} minutes`;
    res.json({ message: `Member ${action}`, isMuted: targetParticipant.isMuted, mutedUntil: targetParticipant.mutedUntil });
  } catch (error) {
    console.error('Error muting member:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Ban a member from the group
 * PATCH /groups/:groupId/members/:memberId/ban
 * Admin+ can ban members/moderators
 */
const banMember = async (req, res) => {
  try {
    const { groupId, memberId } = req.params;
    const actorId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!['admin', 'owner'].includes(actorRole)) {
      return res.status(403).json({ error: 'Only admins and owners can ban members' });
    }

    const targetParticipant = conversation.participants.find(
      p => p.userId.toString() === memberId && !p.leftAt
    );
    if (!targetParticipant) return res.status(404).json({ error: 'Member not found' });

    if (!Conversation.canManage(actorRole, targetParticipant.role)) {
      return res.status(403).json({ error: 'Insufficient permissions to ban this member' });
    }

    targetParticipant.isBanned = true;
    targetParticipant.leftAt = new Date();
    await conversation.save();

    // Get target user's name for system message
    const targetUser = await User.findById(memberId).select('name username');
    const targetName = targetUser?.name || targetUser?.username || 'A member';

    // Create system message
    const systemMessage = new Message({
      conversationId: groupId,
      senderId: actorId,
      content: `${targetName} was banned from the group`,
      messageType: 'system'
    });
    await systemMessage.save();

    // Notify gateway to kick the banned user from the conversation room
    try {
      if (!redisClient) {
        const redis = require('redis');
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.log('Redis Client Error', err));
        await redisClient.connect();
      }
      await redisClient.publish('chat.member.banned', JSON.stringify({ userId: memberId, conversationId: groupId }));
      // Broadcast system message to remaining members
      await redisClient.publish('chat.group.message', JSON.stringify({
        messageId: systemMessage._id,
        conversationId: groupId,
        senderId: actorId,
        content: systemMessage.content,
        messageType: 'system',
        timestamp: systemMessage.createdAt
      }));
    } catch (redisError) {
      console.error('Redis publish failed for ban event:', redisError.message);
    }

    res.json({ message: 'Member banned from group' });
  } catch (error) {
    console.error('Error banning member:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Unban a member from the group
 * PATCH /groups/:groupId/members/:memberId/unban
 * Admin+ can unban
 */
const unbanMember = async (req, res) => {
  try {
    const { groupId, memberId } = req.params;
    const actorId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!['admin', 'owner'].includes(actorRole)) {
      return res.status(403).json({ error: 'Only admins and owners can unban members' });
    }

    const targetParticipant = conversation.participants.find(
      p => p.userId.toString() === memberId && p.isBanned
    );
    if (!targetParticipant) return res.status(404).json({ error: 'Banned member not found' });

    targetParticipant.isBanned = false;
    targetParticipant.leftAt = null;
    targetParticipant.joinedAt = new Date();
    targetParticipant.role = 'member';
    await conversation.save();

    // Get target user's name for system message
    const targetUser = await User.findById(memberId).select('name username');
    const targetName = targetUser?.name || targetUser?.username || 'A member';

    const systemMessage = new Message({
      conversationId: groupId,
      senderId: actorId,
      content: `${targetName} was unbanned`,
      messageType: 'system'
    });
    await systemMessage.save();

    try {
      if (!redisClient) {
        const redis = require('redis');
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.log('Redis Client Error', err));
        await redisClient.connect();
      }
      await redisClient.publish('chat.group.message', JSON.stringify({
        messageId: systemMessage._id,
        conversationId: groupId,
        senderId: actorId,
        content: systemMessage.content,
        messageType: 'system',
        timestamp: systemMessage.createdAt
      }));
    } catch (redisError) {
      console.error('Redis publish failed for unban event:', redisError.message);
    }

    res.json({ message: 'Member unbanned' });
  } catch (error) {
    console.error('Error unbanning member:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Leave a group (self-remove)
 * POST /groups/:groupId/leave
 */
const leaveGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const participant = conversation.participants.find(
      p => p.userId.toString() === userId.toString() && !p.leftAt && !p.isBanned
    );
    if (!participant) return res.status(404).json({ error: 'You are not a member of this group' });

    if (participant.role === 'owner') {
      // If owner is leaving, check if there are other members to transfer ownership
      const otherMembers = conversation.participants.filter(
        p => p.userId.toString() !== userId.toString() && !p.leftAt && !p.isBanned
      );
      if (otherMembers.length > 0) {
        // Transfer ownership to highest-ranked remaining member
        const ranked = otherMembers.sort(
          (a, b) => (Conversation.ROLE_RANK[b.role] || 0) - (Conversation.ROLE_RANK[a.role] || 0)
        );
        ranked[0].role = 'owner';
      }
    }

    participant.leftAt = new Date();
    await conversation.save();

    // Get user name for system message
    const leavingUser = await User.findById(userId).select('name username');
    const leavingName = leavingUser?.name || leavingUser?.username || 'A member';

    const systemMessage = new Message({
      conversationId: groupId,
      senderId: userId,
      content: `${leavingName} left the group`,
      messageType: 'system'
    });
    await systemMessage.save();

    try {
      if (!redisClient) {
        const redis = require('redis');
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.log('Redis Client Error', err));
        await redisClient.connect();
      }
      await redisClient.publish('chat.group.message', JSON.stringify({
        messageId: systemMessage._id,
        conversationId: groupId,
        senderId: userId,
        content: systemMessage.content,
        messageType: 'system',
        timestamp: systemMessage.createdAt,
        // Include the updated active participant count so clients can refresh
        // their cached count without an extra API round-trip.
        participantCount: conversation.activeParticipants.length,
        systemEvent: 'member_left',
        affectedUserId: userId.toString()
      }));
    } catch (redisError) {
      console.error('Redis publish failed for leave event:', redisError.message);
    }

    res.json({ message: 'You have left the group' });
  } catch (error) {
    console.error('Error leaving group:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Delete a message (admin / moderator)
 * DELETE /messages/:messageId
 */
const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.userId;

    const message = await Message.findById(messageId);
    if (!message || message.deletedAt) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const conversation = await Conversation.findById(message.conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const userRole = conversation.getUserRole(userId);
    const isOwnMessage = message.senderId.toString() === userId.toString();

    // Own messages can always be deleted; others require moderator+
    if (!isOwnMessage && !['moderator', 'admin', 'owner'].includes(userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions to delete this message' });
    }

    message.deletedAt = new Date();
    message.content = 'This message was deleted.';
    await message.save();

    res.json({ message: 'Message deleted' });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Delete the entire group (owner only)
 * DELETE /groups/:groupId
 */
const deleteGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const userRole = conversation.getUserRole(userId);
    if (userRole !== 'owner') {
      return res.status(403).json({ error: 'Only the group owner can delete the group' });
    }

    await Message.deleteMany({ conversationId: groupId });
    await Conversation.findByIdAndDelete(groupId);

    res.json({ message: 'Group deleted successfully' });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get moderation/lock history for a group
 * GET /groups/:groupId/moderation/history
 * Requires: moderator+
 */
const getModerationHistory = async (req, res) => {
  try {
    const { groupId } = req.params;
    const actorId = req.userId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const before = req.query.before; // ISO timestamp for cursor pagination
    const action = req.query.action;  // optional: lock | unlock | reset | export
    const triggeredBy = req.query.triggeredBy; // optional: auto | manual

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!actorRole) return res.status(403).json({ error: 'Not a member of this group' });

    if (Conversation.ROLE_RANK[actorRole] < Conversation.ROLE_RANK['moderator']) {
      return res.status(403).json({ error: 'Moderator access required' });
    }

    const query = { conversationId: groupId };
    if (action && ['lock', 'unlock', 'reset', 'export'].includes(action)) {
      query.action = action;
    }
    if (triggeredBy && ['auto', 'manual'].includes(triggeredBy)) {
      query.triggeredBy = triggeredBy;
    }
    if (before) {
      const beforeDate = new Date(before);
      if (!isNaN(beforeDate.getTime())) {
        query.createdAt = { $lt: beforeDate };
      }
    }

    const logs = await ModerationLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Manual cross-connection populate — User lives on authConn, default
    // mongoose populate can't resolve it.
    const actorIds = [...new Set(logs.map(l => l.actorId).filter(Boolean).map(String))];
    if (actorIds.length) {
      const actors = await User.find({ _id: { $in: actorIds } })
        .select('name username avatar')
        .lean();
      const actorMap = new Map(actors.map(a => [String(a._id), a]));
      for (const log of logs) {
        if (log.actorId) {
          const a = actorMap.get(String(log.actorId));
          if (a) log.actorId = a;
        }
      }
    }

    res.json(logs);
  } catch (error) {
    console.error('Error getting moderation history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get the top toxic members for a group within a window.
 * GET /groups/:groupId/moderation/top-toxic?days=7&limit=5&minFlags=3
 * Requires: moderator+
 *
 * Ranking score = avg_toxicity * log10(flagged_count + 1)
 * — punishes severity AND frequency, prevents single-message outliers
 *   from dominating the leaderboard.
 */
const getTopToxicUsers = async (req, res) => {
  try {
    const { groupId } = req.params;
    const actorId = req.userId;
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 25);
    const minFlags = Math.min(Math.max(parseInt(req.query.minFlags) || 3, 1), 50);

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!actorRole) return res.status(403).json({ error: 'Not a member of this group' });

    if (Conversation.ROLE_RANK[actorRole] < Conversation.ROLE_RANK['moderator']) {
      return res.status(403).json({ error: 'Moderator access required' });
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const ConvId = require('mongoose').Types.ObjectId;

    const agg = await FlaggedMessage.aggregate([
      {
        $match: {
          conversationId: new ConvId(groupId),
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: '$senderId',
          avgToxicity: { $avg: '$toxicity' },
          maxToxicity: { $max: '$toxicity' },
          flaggedCount: {
            $sum: { $cond: ['$flagged', 1, 0] },
          },
          totalCount: { $sum: 1 },
          lastFlaggedAt: { $max: '$createdAt' },
        },
      },
      {
        $match: {
          // require some volume so single outliers don't top the list
          totalCount: { $gte: minFlags },
        },
      },
      {
        $addFields: {
          // severity × frequency, log-scaled
          score: {
            $multiply: [
              '$avgToxicity',
              { $log10: { $add: ['$totalCount', 1] } },
            ],
          },
        },
      },
      { $sort: { score: -1 } },
      { $limit: limit },
    ]);

    // Resolve usernames from the auth-database User collection.
    const userIds = agg.map((row) => row._id).filter(Boolean);
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } })
          .select('_id name username avatar')
          .lean()
      : [];
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const ranked = agg.map((row, i) => {
      const u = userMap.get(String(row._id)) || {};
      return {
        rank: i + 1,
        userId: row._id,
        name: u.name || null,
        username: u.username || null,
        avatar: u.avatar || null,
        avgToxicity: +row.avgToxicity.toFixed(4),
        maxToxicity: +row.maxToxicity.toFixed(4),
        flaggedCount: row.flaggedCount,
        totalCount: row.totalCount,
        lastFlaggedAt: row.lastFlaggedAt,
        score: +row.score.toFixed(4),
      };
    });

    res.json({
      windowDays: days,
      generatedAt: new Date().toISOString(),
      users: ranked,
    });
  } catch (error) {
    console.error('Error computing top toxic users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Audit a moderation data export.
 * POST /groups/:groupId/moderation/audit-export
 * Body: { type: 'history' | 'top-toxic' | 'full', rows: number, range?: string }
 * Requires: moderator+
 *
 * Writes a ModerationLog entry of action='export' so admins can't quietly
 * exfiltrate member toxicity data without a trail.
 */
const auditModerationExport = async (req, res) => {
  try {
    const { groupId } = req.params;
    const actorId = req.userId;
    const { type, rows, range } = req.body || {};

    if (!['history', 'top-toxic', 'timeline', 'full'].includes(type)) {
      return res.status(400).json({ error: 'Invalid export type' });
    }

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!actorRole) return res.status(403).json({ error: 'Not a member of this group' });

    if (Conversation.ROLE_RANK[actorRole] < Conversation.ROLE_RANK['moderator']) {
      return res.status(403).json({ error: 'Moderator access required' });
    }

    await ModerationLog.create({
      conversationId: groupId,
      action: 'export',
      triggeredBy: 'manual',
      actorId,
      metadata: {
        type,
        rows: typeof rows === 'number' ? rows : null,
        range: typeof range === 'string' ? range.slice(0, 64) : null,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error logging export audit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get moderation stats for a group
 * GET /groups/:groupId/moderation/stats
 * Requires: moderator+
 */
const getModerationStats = async (req, res) => {
  try {
    const { groupId } = req.params;
    const actorId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!actorRole) return res.status(403).json({ error: 'Not a member of this group' });

    if (Conversation.ROLE_RANK[actorRole] < Conversation.ROLE_RANK['moderator']) {
      return res.status(403).json({ error: 'Moderator access required' });
    }

    if (!redisClient) {
      const redis = require('redis');
      redisClient = redis.createClient({ url: process.env.REDIS_URL });
      redisClient.on('error', (err) => console.log('Redis Client Error', err));
      await redisClient.connect();
    }

    // Read sentiment window from Redis sorted set
    const windowKey = `sentiment:window:${groupId}`;
    const lockKey = `sentiment:lock:${groupId}`;

    const rawEntries = await redisClient.zRange(windowKey, 0, -1);
    const locked = await redisClient.exists(lockKey) === 1;
    let unlockTime = null;

    if (locked) {
      const ttl = await redisClient.ttl(lockKey);
      if (ttl > 0) {
        unlockTime = Date.now() / 1000 + ttl;
      }
    }

    if (!rawEntries || rawEntries.length === 0) {
      return res.json({
        avg_toxicity: 0, negative_ratio: 0, moderation_score: 0,
        avg_sentiment: 0, mood: 'neutral', status: 'normal',
        locked, unlockTime, window_size: 0
      });
    }

    const entries = rawEntries.map(e => JSON.parse(e));
    const avgToxicity = entries.reduce((s, e) => s + e.toxicity, 0) / entries.length;

    const harmfulNeg = entries.filter(e => e.sentiment === 'NEGATIVE' && e.toxicity > 0.3).length;
    const negativeRatio = harmfulNeg / entries.length;

    let moderationScore = (0.7 * avgToxicity) + (0.3 * negativeRatio);
    if (avgToxicity < 0.2) moderationScore = Math.min(moderationScore, 0.25);

    const sentimentMap = { POSITIVE: 1, NEUTRAL: 0, NEGATIVE: -1 };
    const avgSentiment = entries.reduce((s, e) => s + (sentimentMap[e.sentiment] || 0), 0) / entries.length;

    const posRatio = entries.filter(e => e.sentiment === 'POSITIVE').length / entries.length;
    const neutralRatio = entries.filter(e => e.sentiment === 'NEUTRAL').length / entries.length;

    let mood = 'mixed';
    if (posRatio > 0.6) mood = 'positive';
    else if (negativeRatio > 0.4) mood = 'negative';
    else if (neutralRatio > 0.5) mood = 'neutral';

    let status = 'normal';
    if (moderationScore >= 0.8) status = 'auto_lock';
    else if (moderationScore >= 0.6) status = 'notify_moderator';
    else if (moderationScore >= 0.3) status = 'warning';

    res.json({
      avg_toxicity: +avgToxicity.toFixed(4),
      negative_ratio: +negativeRatio.toFixed(4),
      moderation_score: +moderationScore.toFixed(4),
      avg_sentiment: +avgSentiment.toFixed(4),
      mood, status, locked, unlockTime,
      window_size: entries.length
    });
  } catch (error) {
    console.error('Error getting moderation stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Manually lock a group
 * POST /groups/:groupId/moderation/lock
 * Requires: moderator+
 */
const moderationLockGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const actorId = req.userId;
    const { duration } = req.body; // optional: override duration in seconds

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!actorRole) return res.status(403).json({ error: 'Not a member of this group' });

    if (Conversation.ROLE_RANK[actorRole] < Conversation.ROLE_RANK['moderator']) {
      return res.status(403).json({ error: 'Moderator access required' });
    }

    if (!redisClient) {
      const redis = require('redis');
      redisClient = redis.createClient({ url: process.env.REDIS_URL });
      redisClient.on('error', (err) => console.log('Redis Client Error', err));
      await redisClient.connect();
    }

    const lockKey = `sentiment:lock:${groupId}`;
    const lockDuration = (duration && Number.isInteger(duration) && duration > 0 && duration <= 86400)
      ? duration : 1800;

    await redisClient.setEx(lockKey, lockDuration, 'locked');
    const unlockTime = Date.now() / 1000 + lockDuration;

    // Log lock event
    await ModerationLog.create({
      conversationId: groupId,
      action: 'lock',
      triggeredBy: 'manual',
      actorId,
      duration: lockDuration
    });

    // Publish lock event so websocket-gateway can broadcast
    await redisClient.publish('chat.moderation.lock', JSON.stringify({
      conversationId: groupId,
      locked: true,
      unlockTime,
      triggeredBy: actorId,
      timestamp: Date.now()
    }));

    res.json({ success: true, locked: true, unlockTime, duration: lockDuration });
  } catch (error) {
    console.error('Error locking group:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Manually unlock a group
 * POST /groups/:groupId/moderation/unlock
 * Requires: moderator+
 */
const moderationUnlockGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const actorId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!actorRole) return res.status(403).json({ error: 'Not a member of this group' });

    if (Conversation.ROLE_RANK[actorRole] < Conversation.ROLE_RANK['moderator']) {
      return res.status(403).json({ error: 'Moderator access required' });
    }

    if (!redisClient) {
      const redis = require('redis');
      redisClient = redis.createClient({ url: process.env.REDIS_URL });
      redisClient.on('error', (err) => console.log('Redis Client Error', err));
      await redisClient.connect();
    }

    const lockKey = `sentiment:lock:${groupId}`;
    await redisClient.del(lockKey);

    // Log unlock event
    await ModerationLog.create({
      conversationId: groupId,
      action: 'unlock',
      triggeredBy: 'manual',
      actorId
    });

    // Publish unlock event
    await redisClient.publish('chat.moderation.unlock', JSON.stringify({
      conversationId: groupId,
      locked: false,
      triggeredBy: actorId,
      timestamp: Date.now()
    }));

    res.json({ success: true, locked: false });
  } catch (error) {
    console.error('Error unlocking group:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Reset sentiment window for a group
 * POST /groups/:groupId/moderation/reset
 * Requires: admin+
 */
const moderationResetWindow = async (req, res) => {
  try {
    const { groupId } = req.params;
    const actorId = req.userId;

    const conversation = await Conversation.findById(groupId);
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actorRole = conversation.getUserRole(actorId);
    if (!actorRole) return res.status(403).json({ error: 'Not a member of this group' });

    if (Conversation.ROLE_RANK[actorRole] < Conversation.ROLE_RANK['admin']) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!redisClient) {
      const redis = require('redis');
      redisClient = redis.createClient({ url: process.env.REDIS_URL });
      redisClient.on('error', (err) => console.log('Redis Client Error', err));
      await redisClient.connect();
    }

    const windowKey = `sentiment:window:${groupId}`;
    await redisClient.del(windowKey);

    // Log reset event
    await ModerationLog.create({
      conversationId: groupId,
      action: 'reset',
      triggeredBy: 'manual',
      actorId
    });

    // Publish reset event
    await redisClient.publish('chat.moderation.reset', JSON.stringify({
      conversationId: groupId,
      triggeredBy: actorId,
      timestamp: Date.now()
    }));

    res.json({ success: true, message: 'Sentiment window reset' });
  } catch (error) {
    console.error('Error resetting sentiment window:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
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
  setRedisClient,
  getModerationStats,
  getModerationHistory,
  moderationLockGroup,
  moderationUnlockGroup,
  moderationResetWindow,
  getTopToxicUsers,
  auditModerationExport
};