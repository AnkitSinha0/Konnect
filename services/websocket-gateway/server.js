require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const redis = require('redis'); // Try original redis client instead of ioredis
const jwt = require('jsonwebtoken');
const { Kafka } = require('kafkajs');

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

// Redis clients for TCP pub/sub (keeping TCP as requested)
let presenceClient, pubClient, subClient;

// Local cache for this server instance (still needed for Socket.IO routing)
const connectedUsers = new Map(); // Local users on this server instance
const userSockets = new Map(); // socketId -> userId mapping for this server

// Track banned/muted members: Set of "userId:conversationId" strings
const bannedInConv = new Set();
const mutedInConv = new Map(); // "userId:conversationId" -> mutedUntil (Date)

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Get Redis presence count for total online users across all instances
    let totalOnlineUsers = 0;
    let redisConnected = false;
    
    if (presenceClient && presenceClient.isReady) {
      try {
        const onlineKeys = await presenceClient.keys('online:*');
        totalOnlineUsers = onlineKeys.length;
        redisConnected = true;
      } catch (redisError) {
        // If Redis is down, fall back to local count
        totalOnlineUsers = connectedUsers.size;
        redisConnected = false;
      }
    } else {
      totalOnlineUsers = connectedUsers.size;
      redisConnected = false;
    }
    
    res.status(200).json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      service: 'websocket-gateway',
      version: '1.0.0',
      serverId: process.pid,
      localConnectedUsers: connectedUsers.size,
      totalOnlineUsers: totalOnlineUsers,
      redis: {
        connected: redisConnected
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Also expose health check under /ws for Traefik routing
app.get('/ws/health', async (req, res) => {
  try {
    let totalOnlineUsers = 0;
    let redisConnected = false;
    
    if (presenceClient && presenceClient.isReady) {
      try {
        const onlineKeys = await presenceClient.keys('online:*');
        totalOnlineUsers = onlineKeys.length;
        redisConnected = true;
      } catch (redisError) {
        totalOnlineUsers = connectedUsers.size;
        redisConnected = false;
      }
    } else {
      totalOnlineUsers = connectedUsers.size;
      redisConnected = false;
    }
    
    res.status(200).json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      service: 'websocket-gateway',
      version: '1.0.0',
      serverId: process.pid,
      localConnectedUsers: connectedUsers.size,
      totalOnlineUsers: totalOnlineUsers,
      redis: {
        connected: redisConnected
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// WebSocket Authentication Middleware
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
    if (!token) {
      return next(new Error('No token provided'));
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('WebSocket JWT decoded payload:', decoded);
    
    // Handle both old and new token formats for backward compatibility
    socket.userId = decoded.userId || decoded.id;
    socket.userEmail = decoded.email;
    socket.userName = decoded.name || decoded.email;
    
    if (!socket.userId) {
      console.error('No user ID found in WebSocket token payload:', decoded);
      return next(new Error('Invalid token payload'));
    }
    
    console.log('WebSocket auth successful for user:', socket.userId);
    next();
  } catch (error) {
    console.error('WebSocket authentication failed:', error.message);
    next(new Error('Authentication failed: ' + error.message));
  }
});

// WebSocket Connection Handler
io.on('connection', async (socket) => {
  const userId = socket.userId;
  console.log(`✅ User connected: ${socket.userName} (${userId})`);
  
  try {
    // Store user presence in Redis with TTL (shared across all Gateway instances)
    if (presenceClient && presenceClient.isReady) {
      try {
        await presenceClient.setEx(`online:${userId}`, 3600, socket.id); // 1 hour TTL
        // Clear any stale lastSeen while user is online
        await presenceClient.del(`lastSeen:${userId}`);
        console.log(`✅ User presence stored in Redis: ${userId}`);
      } catch (redisError) {
        console.error('⚠️ Failed to set Redis presence (continuing anyway):', redisError.message);
      }
    }
    
    // Update local maps for this server instance (still needed for local Socket.IO routing)
    connectedUsers.set(userId, socket.id);
    userSockets.set(socket.id, userId);
    
    // Join personal room for direct messages
    socket.join(`user:${userId}`);
    
    // Publish user online event to other Gateway instances via Redis
    if (pubClient && pubClient.isReady) {
      try {
        await pubClient.publish('user.presence', JSON.stringify({
          type: 'online',
          userId,
          userName: socket.userName,
          serverId: process.pid, // Identify which server instance
          timestamp: new Date().toISOString()
        }));
      } catch (redisError) {
        console.error('⚠️ Failed to publish presence event:', redisError.message);
      }
    }
    
    // Notify other users on THIS server that user is online
    socket.broadcast.emit('user:online', {
      userId,
      userName: socket.userName,
      timestamp: new Date().toISOString()
    });

    // Handle check online status for a specific user
    socket.on('user:checkOnline', async ({ targetUserId }, callback) => {
      try {
        let online = false;
        let lastSeen = null;
        if (presenceClient && presenceClient.isReady) {
          const socketId = await presenceClient.get(`online:${targetUserId}`);
          online = !!socketId;
          if (!online) {
            lastSeen = await presenceClient.get(`lastSeen:${targetUserId}`);
          }
        } else {
          online = connectedUsers.has(targetUserId);
        }
        if (typeof callback === 'function') callback({ online, lastSeen });
        else socket.emit('user:onlineStatus', { userId: targetUserId, online, lastSeen });
      } catch (err) {
        if (typeof callback === 'function') callback({ online: false, lastSeen: null });
      }
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

    // Check which group members are online
    socket.on('group:getOnlineMembers', async ({ memberIds }) => {
      if (!memberIds || !Array.isArray(memberIds)) return;
      try {
        const onlineIds = [];
        if (presenceClient && presenceClient.isReady) {
          for (const id of memberIds) {
            const isOnline = await presenceClient.get(`online:${id}`);
            if (isOnline) onlineIds.push(id);
          }
        } else {
          // Fallback to local map
          for (const id of memberIds) {
            if (connectedUsers.has(id)) onlineIds.push(id);
          }
        }
        socket.emit('group:onlineMembers', { onlineIds });
      } catch (err) {
        console.error('Error checking group online members:', err);
        socket.emit('group:onlineMembers', { onlineIds: [] });
      }
    });
    
    // Handle typing indicators (accept string or object)
    socket.on('typing:start', (data) => {
      const conversationId = typeof data === 'string' ? data : data?.conversationId;
      const targetUserId = typeof data === 'object' ? data?.targetUserId : null;
      console.log(`⌨️  typing:start from ${userId} conv=${conversationId} target=${targetUserId}`);
      if (!conversationId) return;

      // Block banned or currently muted users from emitting typing
      const memberKey = `${userId}:${conversationId}`;
      if (bannedInConv.has(memberKey)) return;
      const mutedUntil = mutedInConv.get(memberKey);
      if (mutedUntil !== undefined) {
        if (mutedUntil === null || mutedUntil > new Date()) return;
        mutedInConv.delete(memberKey); // mute expired
      }

      const payload = { userId, userName: socket.userName, conversationId, isTyping: true };
      if (targetUserId) {
        // Direct 1:1: emit to target's personal room — no room join required
        io.to(`user:${targetUserId}`).emit('user:typing', payload);
      } else {
        // Group: broadcast to conversation room
        socket.to(`conversation:${conversationId}`).emit('user:typing', payload);
      }
    });

    socket.on('typing:stop', (data) => {
      const conversationId = typeof data === 'string' ? data : data?.conversationId;
      const targetUserId = typeof data === 'object' ? data?.targetUserId : null;
      if (!conversationId) return;

      // Block banned users from emitting typing:stop as well
      if (bannedInConv.has(`${userId}:${conversationId}`)) return;

      const payload = { userId, userName: socket.userName, conversationId, isTyping: false };
      if (targetUserId) {
        io.to(`user:${targetUserId}`).emit('user:typing', payload);
      } else {
        socket.to(`conversation:${conversationId}`).emit('user:typing', payload);
      }
    });
    
    // Handle sending messages
    socket.on('message:send', async (data) => {
      const { conversationId, content, type = 'text', tempId } = data;
      console.log(`📤 User ${userId} sending message to ${conversationId}: ${content.substring(0, 50)}...`);
      
      try {
        // Send message to chat service via HTTP API
        const response = await fetch('http://chat-service:3003/api/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${socket.handshake.auth.token}`
          },
          body: JSON.stringify({
            conversationId,
            content,
            messageType: type, // Fixed field name mismatch
            tempId
          })
        });
        
        if (response.ok) {
          const messageData = await response.json();
          console.log(`✅ Message saved to database:`, messageData.messageId);
          
          // Send acknowledgment back to sender
          socket.emit('message:ack', {
            tempId,
            messageId: messageData.messageId,
            status: 'sent',
            timestamp: messageData.timestamp
          });
        } else {
          console.error(`❌ Failed to save message: ${response.status}`);
          const error = await response.text();
          
          // Send error back to sender  
          socket.emit('message:error', {
            tempId,
            error: `Failed to send message: ${error}`,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error('❌ Error sending message:', error);
        
        // Send error back to sender
        socket.emit('message:error', {
          tempId,
          error: `Network error: ${error.message}`,
          timestamp: new Date().toISOString()
        });
      }
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
        if (presenceClient && presenceClient.isReady) {
          const onlineKeys = await presenceClient.keys('online:*');
          const onlineUserIds = onlineKeys.map(key => key.replace('online:', ''));
          
          socket.emit('users:online', {
            userIds: onlineUserIds,
            count: onlineUserIds.length
          });
        } else {
          // Fallback to local users only if Redis is not available
          const localUserIds = Array.from(connectedUsers.keys());
          socket.emit('users:online', {
            userIds: localUserIds,
            count: localUserIds.length,
            note: 'Local server only (Redis not connected)'
          });
        }
      } catch (error) {
        console.error('Error fetching online users:', error);
        // Fallback to local users
        const localUserIds = Array.from(connectedUsers.keys());
        socket.emit('users:online', {
          userIds: localUserIds,
          count: localUserIds.length,
          note: 'Redis error - showing local users only'
        });
      }
    });
    
    // Handle disconnection
    socket.on('disconnect', async (reason) => {
      console.log(`❌ User disconnected: ${socket.userName} (${reason})`);
      
      try {
        // Remove from Redis presence and store lastSeen timestamp
        if (presenceClient && presenceClient.isReady) {
          try {
            await presenceClient.del(`online:${userId}`);
            await presenceClient.set(`lastSeen:${userId}`, new Date().toISOString());
            console.log(`✅ User presence removed from Redis: ${userId}`);
          } catch (redisError) {
            console.error('⚠️ Failed to remove Redis presence:', redisError.message);
          }
        }
        
        // Remove from local maps
        connectedUsers.delete(userId);
        userSockets.delete(socket.id);
        
        // Publish user offline event to other Gateway instances via Redis
        if (pubClient && pubClient.isReady) {
          try {
            await pubClient.publish('user.presence', JSON.stringify({
              type: 'offline',
              userId,
              userName: socket.userName,
              lastSeen: new Date().toISOString(),
              serverId: process.pid,
              timestamp: new Date().toISOString()
            }));
          } catch (redisError) {
            console.error('⚠️ Failed to publish offline event:', redisError.message);
          }
        }
        
        // Notify others on THIS server that user is offline
        const offlineTimestamp = new Date().toISOString();
        socket.broadcast.emit('user:offline', {
          userId,
          userName: socket.userName,
          lastSeen: offlineTimestamp,
          timestamp: offlineTimestamp
        });
        
      } catch (error) {
        console.error('Error handling disconnect:', error);
      }
    });
    
  } catch (error) {
    console.error('Error in connection handler:', error);
  }
});

// Redis Pub/Sub Message Handler for incoming chat messages and presence events
const handleIncomingMessage = async (channel, message) => {
  try {
    const data = JSON.parse(message);
    
    switch (channel) {
      case 'user.presence':
        // Handle presence events from other Gateway instances
        if (data.serverId !== process.pid) { // Ignore our own presence events
          console.log(`👥 Presence event from server ${data.serverId}: ${data.type} - ${data.userId}`);
          
          // Broadcast presence to connected users on this server
          if (data.type === 'online') {
            io.emit('user:online', {
              userId: data.userId,
              userName: data.userName,
              timestamp: data.timestamp
            });
          } else if (data.type === 'offline') {
            io.emit('user:offline', {
              userId: data.userId,
              userName: data.userName,
              lastSeen: data.lastSeen || data.timestamp,
              timestamp: data.timestamp
            });
          }
        }
        break;
        
      case 'chat.message':
        // Handle 1:1 chat message
        console.log(`📨 Direct message: ${data.senderId} -> ${data.receiverId}`);
        
        // Send to receiver if online on THIS server instance
        const receiverSocketId = connectedUsers.get(data.receiverId.toString());
        if (receiverSocketId) {
          io.to(`user:${data.receiverId}`).emit('message:new', data);
          console.log(`✅ Message delivered to user ${data.receiverId} on this server`);
        } else {
          console.log(`📱 User ${data.receiverId} not on this server (may be on another instance)`);
        }
        
        // Also notify sender for delivery confirmation (if on this server)
        const senderSocketId = connectedUsers.get(data.senderId.toString());
        if (senderSocketId) {
          io.to(`user:${data.senderId}`).emit('message:sent', {
            messageId: data.messageId,
            conversationId: data.conversationId,
            status: 'sent' // Status will be confirmed by the receiving server
          });
        }
        break;
        
      case 'chat.group.message':
        // Handle group chat message
        console.log(`📨 Group message in conversation ${data.conversationId}`);
        
        // Send to all participants EXCEPT the sender (sender already has the optimistic temp message)
        const groupSenderSocketId = connectedUsers.get(data.senderId.toString());
        if (groupSenderSocketId) {
          io.to(`conversation:${data.conversationId}`).except(groupSenderSocketId).emit('message:new', data);
        } else {
          io.to(`conversation:${data.conversationId}`).emit('message:new', data);
        }
        
        // Notify sender (if on this server)
        if (groupSenderSocketId) {
          io.to(`user:${data.senderId}`).emit('message:sent', {
            messageId: data.messageId,
            conversationId: data.conversationId,
            status: 'delivered'
          });
        }
        
        console.log(`✅ Group message delivered to conversation ${data.conversationId} on this server`);
        break;
        
      case 'chat.member.banned': {
        const key = `${data.userId}:${data.conversationId}`;
        bannedInConv.add(key);
        // Kick the banned user out of the conversation socket room
        const bannedSocketId = connectedUsers.get(data.userId.toString());
        if (bannedSocketId) {
          const bannedSocket = io.sockets.sockets.get(bannedSocketId);
          if (bannedSocket) {
            bannedSocket.leave(`conversation:${data.conversationId}`);
            bannedSocket.emit('member:banned', { conversationId: data.conversationId });
          }
        }
        console.log(`🚫 User ${data.userId} banned from conversation ${data.conversationId}`);
        break;
      }

      case 'chat.member.removed': {
        // Kick the removed user out of the conversation socket room
        const removedSocketId = connectedUsers.get(data.userId.toString());
        if (removedSocketId) {
          const removedSocket = io.sockets.sockets.get(removedSocketId);
          if (removedSocket) {
            removedSocket.leave(`conversation:${data.conversationId}`);
            removedSocket.emit('member:removed', { conversationId: data.conversationId });
          }
        }
        console.log(`👢 User ${data.userId} removed from conversation ${data.conversationId}`);
        break;
      }

      case 'chat.member.muted': {
        const muteKey = `${data.userId}:${data.conversationId}`;
        mutedInConv.set(muteKey, data.mutedUntil ? new Date(data.mutedUntil) : null);
        // Emit mute event to the target user so their UI can show the countdown
        const mutedSocketId = connectedUsers.get(data.userId.toString());
        if (mutedSocketId) {
          const mutedSocket = io.sockets.sockets.get(mutedSocketId);
          if (mutedSocket) {
            mutedSocket.emit('member:muted', {
              conversationId: data.conversationId,
              mutedUntil: data.mutedUntil,
              durationMinutes: data.durationMinutes
            });
          }
        }
        console.log(`🔇 User ${data.userId} muted in conversation ${data.conversationId} until ${data.mutedUntil}`);
        break;
      }

      case 'chat.member.unmuted': {
        const unmuteKey = `${data.userId}:${data.conversationId}`;
        mutedInConv.delete(unmuteKey);
        // Emit unmute event to the target user
        const unmutedSocketId = connectedUsers.get(data.userId.toString());
        if (unmutedSocketId) {
          const unmutedSocket = io.sockets.sockets.get(unmutedSocketId);
          if (unmutedSocket) {
            unmutedSocket.emit('member:unmuted', { conversationId: data.conversationId });
          }
        }
        console.log(`🔊 User ${data.userId} unmuted in conversation ${data.conversationId}`);
        break;
      }

      case 'chat.moderation.lock': {
        io.to(`conversation:${data.conversationId}`).emit('moderation:locked', {
          conversationId: data.conversationId,
          locked: true,
          unlockTime: data.unlockTime,
          triggeredBy: data.triggeredBy,
          timestamp: data.timestamp,
        });
        console.log(`🔒 Group ${data.conversationId} manually locked by ${data.triggeredBy}`);
        break;
      }

      case 'chat.moderation.unlock': {
        io.to(`conversation:${data.conversationId}`).emit('moderation:unlocked', {
          conversationId: data.conversationId,
          locked: false,
          triggeredBy: data.triggeredBy,
          timestamp: data.timestamp,
        });
        console.log(`🔓 Group ${data.conversationId} manually unlocked by ${data.triggeredBy}`);
        break;
      }

      case 'chat.moderation.reset': {
        io.to(`conversation:${data.conversationId}`).emit('moderation:reset', {
          conversationId: data.conversationId,
          triggeredBy: data.triggeredBy,
          timestamp: data.timestamp,
        });
        console.log(`🔄 Group ${data.conversationId} sentiment window reset by ${data.triggeredBy}`);
        break;
      }

      default:
        console.log(`❓ Unknown channel: ${channel}`);
    }
  } catch (error) {
    console.error('Error handling incoming message:', error);
  }
};

const start = async () => {
  try {
    console.log('🚀 Starting WebSocket Gateway...');
    
    // Start server first, then connect to Redis
    server.listen(PORT, () => {
      console.log(`🚀 WebSocket Gateway running on port ${PORT}`);
      console.log(`📡 Socket.IO path: /ws/socket.io/`);
      console.log(`🔌 WebSocket events:`);
      console.log(`   - join:conversation - Join conversation room`);
      console.log(`   - leave:conversation - Leave conversation room`);
      console.log(`   - typing:start/stop - Typing indicators`);
      console.log(`   - message:ack - Message acknowledgments`);
      console.log(`   - users:getOnline - Get online users`);
      console.log(`🆔 Server ID: ${process.pid} (for multi-instance scaling)`);
    });

    // Try multiple Redis TCP connection approaches systematically
    if (process.env.REDIS_URL) {
      console.log('🔗 Attempting Redis TCP connection with multiple strategies...');
      
      // Strategy configurations to try in order
      const connectionStrategies = [
        {
          name: 'Secure TCP (rediss://)',
          config: {
            url: process.env.REDIS_URL,
            socket: {
              reconnectStrategy: (retries) => Math.min(retries * 50, 500),
              connectTimeout: 6000,
              tls: true
            }
          }
        },
        {
          name: 'Insecure TCP (redis://)',  
          config: {
            url: process.env.REDIS_URL_ALT1,
            socket: {
              reconnectStrategy: (retries) => Math.min(retries * 50, 500),
              connectTimeout: 6000
            }
          }
        },
        {
          name: 'Host + Password (TLS)',
          config: {
            socket: {
              host: process.env.REDIS_HOST,
              port: 6379,
              tls: true,
              reconnectStrategy: (retries) => Math.min(retries * 50, 500),
              connectTimeout: 6000
            },
            password: process.env.REDIS_PASSWORD
          }
        },
        {
          name: 'Host + Password (no TLS)',
          config: {
            socket: {
              host: process.env.REDIS_HOST,
              port: 6380,
              reconnectStrategy: (retries) => Math.min(retries * 50, 500),
              connectTimeout: 6000
            },
            password: process.env.REDIS_PASSWORD
          }
        }
      ];

      let connected = false;
      let workingStrategy = null;
      
      for (const strategy of connectionStrategies) {
        if (connected) break;
        
        console.log(`🔄 Trying: ${strategy.name}...`);
        
        try {
          // Create test client
          const testClient = redis.createClient(strategy.config);
          
          // Set up error handler for test
          testClient.on('error', () => {}); // Silent during test
          
          // Try to connect with timeout
          await Promise.race([
            testClient.connect(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Connection timeout')), 5000)
            )
          ]);
          
          // Test connection
          await testClient.ping();
          await testClient.quit();
          
          console.log(`   ✅ ${strategy.name} SUCCESS!`);
          workingStrategy = strategy;
          connected = true;
          break;
          
        } catch (error) {
          console.log(`   ❌ ${strategy.name} failed: ${error.message}`);
          continue; // Try next strategy
        }
      }
      
      if (connected && workingStrategy) {
        try {
          // Create actual clients with working configuration
          presenceClient = redis.createClient(workingStrategy.config);
          pubClient = redis.createClient(workingStrategy.config);
          subClient = redis.createClient(workingStrategy.config);
          
          // Error handlers for production clients
          presenceClient.on('error', err => console.error('❌ Redis presence client error:', err.message));
          pubClient.on('error', err => console.error('❌ Redis pub client error:', err.message));
          subClient.on('error', err => console.error('❌ Redis sub client error:', err.message));
          
          // Success handlers
          presenceClient.on('ready', () => console.log('✅ Redis presence client connected'));
          pubClient.on('ready', () => console.log('✅ Redis pub client connected'));
          subClient.on('ready', () => console.log('✅ Redis sub client connected'));
          
          // Connect all clients
          await Promise.all([
            presenceClient.connect(),
            pubClient.connect(),
            subClient.connect()
          ]);
          
          console.log('✅ All Redis TCP clients connected successfully');
          
          // Set up pub/sub subscriptions
          // NOTE: redis v4 subscribe() signature: subscribe(channel, listener)
          // Must subscribe to EACH channel separately with its own listener
          const redisMessageHandler = (message, channel) => {
            handleIncomingMessage(channel, message);
          };

          const channels = [
            process.env.REDIS_CHAT_CHANNEL || 'chat.message',
            process.env.REDIS_GROUP_CHANNEL || 'chat.group.message',
            'user.presence',
            'chat.member.banned',
            'chat.member.removed',
            'chat.member.muted',
            'chat.member.unmuted',
            'chat.moderation.lock',
            'chat.moderation.unlock',
            'chat.moderation.reset'
          ];

          for (const ch of channels) {
            await subClient.subscribe(ch, redisMessageHandler);
            console.log(`  📡 Subscribed to: ${ch}`);
          }
          
          console.log('✅ Redis TCP pub/sub subscriptions active');
          console.log(`📡 Redis pub/sub channels:`);
          console.log(`   - ${process.env.REDIS_CHAT_CHANNEL || 'chat.message'} (1:1 messages)`);
          console.log(`   - ${process.env.REDIS_GROUP_CHANNEL || 'chat.group.message'} (group messages)`);
          console.log(`   - user.presence (cross-server presence sync)`);
          console.log(`🚀 TCP PUB/SUB ENABLED - Horizontal scaling ready! (${workingStrategy.name})`);
          
        } catch (setupError) {
          console.error('❌ Failed to setup Redis clients:', setupError.message);
          connected = false;
        }
      }
      
      if (!connected) {
        console.error('❌ All Redis TCP connection strategies failed');
        console.log('⚠️ Continuing in LOCAL-ONLY mode (single server, no scaling)');
        console.log('📝 Troubleshooting TCP pub/sub:');
        console.log('   1. Check Upstash console - is Redis instance active?');
        console.log('   2. Try: redis-cli -u "rediss://..." ping');
        console.log('   3. Check firewall/network restrictions');
        console.log('   4. Verify credentials match Upstash console');
        console.log('   5. Contact Upstash support if issue persists');
      }
      
    } else {
      console.log('⚠️ No REDIS_URL provided - running in LOCAL-ONLY mode');
    }

    // --- Kafka consumer for sentiment results ---
    const kafkaBroker = process.env.KAFKA_BROKER || 'kafka:9092';
    const sentimentTopic = process.env.KAFKA_SENTIMENT_TOPIC || 'sentiment_results';

    try {
      const kafka = new Kafka({
        clientId: 'websocket-gateway',
        brokers: [kafkaBroker],
        retry: { initialRetryTime: 3000, retries: 15 },
      });

      const sentimentConsumer = kafka.consumer({ groupId: 'ws-sentiment-consumer' });

      const connectWithRetry = async (retries = 10, delay = 5000) => {
        for (let i = 1; i <= retries; i++) {
          try {
            console.log(`🔄 Connecting Kafka consumer (${i}/${retries})...`);
            await sentimentConsumer.connect();
            await sentimentConsumer.subscribe({ topic: sentimentTopic, fromBeginning: false });
            console.log(`✅ Kafka consumer connected – listening on: ${sentimentTopic}`);
            return true;
          } catch (err) {
            console.log(`⏳ Kafka not ready: ${err.message}, retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
        return false;
      };

      const kafkaConnected = await connectWithRetry();

      if (kafkaConnected) {
        await sentimentConsumer.run({
          eachMessage: async ({ message }) => {
            try {
              const data = JSON.parse(message.value.toString());

              if (data.type === 'per_message') {
                // Per-message sentiment result – emit to the conversation room
                io.to(`conversation:${data.conversationId}`).emit('sentiment:message', {
                  messageId: data.messageId,
                  conversationId: data.conversationId,
                  senderId: data.senderId,
                  sentiment: data.sentiment,
                  sentiment_score: data.sentiment_score,
                  toxicity: data.toxicity,
                  flagged: data.flagged,
                  timestamp: data.timestamp,
                });

                // If flagged, also notify moderators / admins
                if (data.flagged) {
                  io.to(`conversation:${data.conversationId}`).emit('moderation:flagged', {
                    messageId: data.messageId,
                    conversationId: data.conversationId,
                    senderId: data.senderId,
                    toxicity: data.toxicity,
                    timestamp: data.timestamp,
                  });
                  console.log(`🚩 Flagged toxic message ${data.messageId} (toxicity: ${data.toxicity})`);
                }

              } else if (data.type === 'group_update') {
                // Group aggregate update – emit to conversation room
                io.to(`conversation:${data.conversationId}`).emit('sentiment:group', {
                  conversationId: data.conversationId,
                  avg_toxicity: data.avg_toxicity,
                  negative_ratio: data.negative_ratio,
                  moderation_score: data.moderation_score,
                  avg_sentiment: data.avg_sentiment,
                  mood: data.mood,
                  status: data.status,
                  locked: data.locked,
                  unlockTime: data.unlockTime,
                  timestamp: data.timestamp,
                });

                // If group was just auto-locked, emit a special event
                if (data.lock_event) {
                  io.to(`conversation:${data.conversationId}`).emit('moderation:locked', {
                    conversationId: data.conversationId,
                    moderation_score: data.moderation_score,
                    unlockTime: data.unlockTime,
                    timestamp: data.timestamp,
                  });
                  console.log(`🔒 Group ${data.conversationId} auto-locked (score: ${data.moderation_score})`);
                }
              }
            } catch (err) {
              console.error('❌ Error processing sentiment message:', err.message);
            }
          },
        });
        console.log('🧠 Sentiment pipeline active – real-time moderation enabled');
      } else {
        console.log('⚠️  Kafka consumer could not connect – sentiment features disabled');
      }
    } catch (kafkaError) {
      console.error('⚠️  Kafka setup failed:', kafkaError.message);
      console.log('⚠️  Continuing without sentiment features');
    }

  } catch (error) {
    console.error('❌ WebSocket Gateway startup error:', error);
    // Don't exit - try to continue without Redis
  }
};

start();