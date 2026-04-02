require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const redis = require('redis');
const jwt = require('jsonwebtoken');

const app = express();
const server = createServer(app);

// Socket.IO configuration
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  path: '/ws/socket.io/' // Custom path since we're behind Traefik
});

const PORT = process.env.PORT || 3004;

// Redis clients
let presenceClient, pubClient, subClient;

// In-memory store for connected users (userId -> socketId mapping)
const connectedUsers = new Map();
const userSockets = new Map(); // socketId -> userId mapping

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'websocket-gateway',
    version: '1.0.0',
    connectedUsers: connectedUsers.size
  });
});

// Also expose health check under /ws for Traefik routing
app.get('/ws/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'websocket-gateway',
    version: '1.0.0',
    connectedUsers: connectedUsers.size
  });
});

// WebSocket Authentication Middleware
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
    if (!token) {
      return next(new Error('No token provided'));
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.userId;
    socket.userEmail = decoded.email;
    socket.userName = decoded.name || decoded.email;
    next();
  } catch (error) {
    next(new Error('Authentication failed: ' + error.message));
  }
});

// WebSocket Connection Handler
io.on('connection', async (socket) => {
  const userId = socket.userId;
  console.log(`✅ User connected: ${socket.userName} (${userId})`);
  
  try {
    // Store user presence in Redis with TTL
    await presenceClient.setEx(`online:${userId}`, 3600, socket.id); // 1 hour TTL
    
    // Update in-memory maps
    connectedUsers.set(userId, socket.id);
    userSockets.set(socket.id, userId);
    
    // Join personal room for direct messages
    socket.join(`user:${userId}`);
    
    // Notify user is online (for presence indicators)
    socket.broadcast.emit('user:online', {
      userId,
      userName: socket.userName,
      timestamp: new Date().toISOString()
    });
    
    // Handle user joining a conversation
    socket.on('join:conversation', (conversationId) => {
      socket.join(`conversation:${conversationId}`);
      console.log(`📞 User ${userId} joined conversation ${conversationId}`);
      
      // Notify others in conversation
      socket.to(`conversation:${conversationId}`).emit('user:joined', {
        userId,
        userName: socket.userName,
        conversationId
      });
    });
    
    // Handle user leaving a conversation
    socket.on('leave:conversation', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
      console.log(`📞 User ${userId} left conversation ${conversationId}`);
      
      // Notify others in conversation
      socket.to(`conversation:${conversationId}`).emit('user:left', {
        userId,
        userName: socket.userName,
        conversationId
      });
    });
    
    // Handle typing indicators
    socket.on('typing:start', (data) => {
      const { conversationId } = data;
      socket.to(`conversation:${conversationId}`).emit('user:typing', {
        userId,
        userName: socket.userName,
        conversationId,
        isTyping: true
      });
    });
    
    socket.on('typing:stop', (data) => {
      const { conversationId } = data;
      socket.to(`conversation:${conversationId}`).emit('user:typing', {
        userId,
        userName: socket.userName,
        conversationId,
        isTyping: false
      });
    });
    
    // Handle message acknowledgments
    socket.on('message:ack', async (data) => {
      const { messageId, status } = data; // status: 'delivered' or 'read'
      console.log(`📨 Message ACK: ${messageId} -> ${status} by user ${userId}`);
      
      try {
        // Update message status via HTTP API
        const response = await fetch(`http://localhost:3003/api/messages/${messageId}/status`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${socket.handshake.auth.token}`
          },
          body: JSON.stringify({ status })
        });
        
        if (response.ok) {
          // Notify sender that message was acknowledged
          const ackData = {
            messageId,
            status,
            acknowledgedBy: userId,
            timestamp: new Date().toISOString()
          };
          
          // Find sender and notify them
          socket.broadcast.emit('message:acknowledged', ackData);
        }
      } catch (error) {
        console.error('Error updating message status:', error);
      }
    });
    
    // Handle online users request
    socket.on('users:getOnline', async () => {
      try {
        const onlineKeys = await presenceClient.keys('online:*');
        const onlineUserIds = onlineKeys.map(key => key.replace('online:', ''));
        
        socket.emit('users:online', {
          userIds: onlineUserIds,
          count: onlineUserIds.length
        });
      } catch (error) {
        console.error('Error fetching online users:', error);
      }
    });
    
    // Handle disconnection
    socket.on('disconnect', async (reason) => {
      console.log(`❌ User disconnected: ${socket.userName} (${reason})`);
      
      try {
        // Remove from Redis presence
        await presenceClient.del(`online:${userId}`);
        
        // Remove from in-memory maps
        connectedUsers.delete(userId);
        userSockets.delete(socket.id);
        
        // Notify others user is offline
        socket.broadcast.emit('user:offline', {
          userId,
          userName: socket.userName,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        console.error('Error handling disconnect:', error);
      }
    });
    
  } catch (error) {
    console.error('Error in connection handler:', error);
  }
});

// Redis Pub/Sub Message Handler for incoming chat messages
const handleIncomingMessage = async (channel, message) => {
  try {
    const data = JSON.parse(message);
    console.log(`📨 Incoming message on channel ${channel}:`, data.messageId);
    
    switch (channel) {
      case 'chat.message':
        // Handle 1:1 chat message
        console.log(`📨 Direct message: ${data.senderId} -> ${data.receiverId}`);
        
        // Send to receiver if online
        const receiverSocketId = connectedUsers.get(data.receiverId.toString());
        if (receiverSocketId) {
          io.to(`user:${data.receiverId}`).emit('message:new', data);
          console.log(`✅ Message delivered to user ${data.receiverId}`);
        } else {
          console.log(`📱 User ${data.receiverId} is offline, message stored in DB`);
        }
        
        // Also notify sender for delivery confirmation
        const senderSocketId = connectedUsers.get(data.senderId.toString());
        if (senderSocketId) {
          io.to(`user:${data.senderId}`).emit('message:sent', {
            messageId: data.messageId,
            conversationId: data.conversationId,
            status: receiverSocketId ? 'delivered' : 'sent'
          });
        }
        break;
        
      case 'chat.group.message':
        // Handle group chat message
        console.log(`📨 Group message in conversation ${data.conversationId}`);
        
        // Send to all participants in the conversation
        io.to(`conversation:${data.conversationId}`).emit('message:new', data);
        
        // Notify sender
        const groupSenderSocketId = connectedUsers.get(data.senderId.toString());
        if (groupSenderSocketId) {
          io.to(`user:${data.senderId}`).emit('message:sent', {
            messageId: data.messageId,
            conversationId: data.conversationId,
            status: 'delivered'
          });
        }
        
        console.log(`✅ Group message delivered to conversation ${data.conversationId}`);
        break;
        
      default:
        console.log(`❓ Unknown channel: ${channel}`);
    }
  } catch (error) {
    console.error('Error handling incoming message:', error);
  }
};

const start = async () => {
  try {
    // For now, skip Redis connections for testing
    console.log('⚠️  WebSocket Gateway: Running without Redis (presence/pub-sub disabled)');
    
    server.listen(PORT, () => {
      console.log(`🚀 WebSocket Gateway running on port ${PORT}`);
      console.log(`📡 Socket.IO path: /ws/socket.io/`);
      console.log(`🔌 WebSocket events:`);
      console.log(`   - join:conversation - Join conversation room`);
      console.log(`   - leave:conversation - Leave conversation room`);
      console.log(`   - typing:start/stop - Typing indicators`);
      console.log(`   - message:ack - Message acknowledgments`);
      console.log(`   - users:getOnline - Get online users`);
    });
  } catch (error) {
    console.error('❌ WebSocket Gateway startup error:', error);
    process.exit(1);
  }
};

start();