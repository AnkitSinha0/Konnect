# WebSocket Gateway - Real-time Communication

This service handles WebSocket connections for the Konnect chat system with **horizontal scaling support**.

## 🚀 Features

- **Socket.IO WebSocket connections** for real-time messaging
- **JWT Authentication** for secure WebSocket connections  
- **Redis Pub/Sub** for cross-server message delivery
- **Presence Management** with Redis shared state
- **Horizontal Scaling** support for multiple server instances
- **Typing Indicators** and message acknowledgments
- **Room-based messaging** for conversations

## 🏗️ Architecture

### Single Server Mode
```
Frontend ↔ WebSocket Gateway ↔ [Local Memory]
```

### Multi-Server Mode (Horizontal Scaling)
```
Frontend ↔ Load Balancer ↔ WebSocket Gateway Instance 1 ┐
                                                        ├─ Redis Pub/Sub
Frontend ↔ Load Balancer ↔ WebSocket Gateway Instance 2 ┘
```

## 🔧 Configuration

### Required Environment Variables

1. **REDIS_URL** - Upstash Redis connection string
   ```bash
   REDIS_URL=redis://default:password@endpoint:6380
   ```

2. **JWT_SECRET** - Must match the auth-service secret
   ```bash
   JWT_SECRET=your_jwt_secret_key
   ```

### Upstash Redis Setup

1. Go to [Upstash Console](https://console.upstash.com/redis)
2. Create a new Redis database
3. Copy the Redis URL from the dashboard
4. Update `.env` with your Redis URL

## 📡 WebSocket Events

### Client → Server
```javascript
// Authentication (required)
socket.auth = { token: 'your_jwt_token' };

// Join/leave conversations
socket.emit('join:conversation', conversationId);
socket.emit('leave:conversation', conversationId);

// Typing indicators
socket.emit('typing:start', { conversationId });
socket.emit('typing:stop', { conversationId });

// Message acknowledgments
socket.emit('message:ack', { messageId, status: 'delivered' });

// Get online users
socket.emit('users:getOnline');
```

### Server → Client
```javascript
// New messages
socket.on('message:new', (messageData) => {});

// Message status updates
socket.on('message:sent', ({ messageId, status }) => {});
socket.on('message:acknowledged', ({ messageId, status }) => {});

// Presence updates
socket.on('user:online', ({ userId, userName }) => {});
socket.on('user:offline', ({ userId, userName }) => {});

// Typing indicators
socket.on('user:typing', ({ userId, userName, isTyping }) => {});

// Online users list
socket.on('users:online', ({ userIds, count }) => {});
```

## 🔄 Scaling How It Works

### 1. **Local State Management**
Each Gateway instance maintains local Maps for:
- `connectedUsers`: userId → socketId (on this server)
- `userSockets`: socketId → userId (on this server)

### 2. **Shared Redis State** 
Global user presence stored in Redis:
- `online:{userId}` → socketId (TTL: 1 hour)

### 3. **Cross-Server Communication**
Redis Pub/Sub channels for:
- `chat.message` - 1:1 message delivery
- `chat.group.message` - Group message delivery  
- `user.presence` - Cross-server presence sync

### 4. **Message Delivery Flow**
1. Chat service publishes message to Redis
2. ALL Gateway instances receive the message
3. Each instance checks local connections
4. Message delivered to users on that specific instance

## 🚦 Health Monitoring

GET `/health` or `/ws/health` returns:
```json
{
  "status": "ok",
  "serverId": 12345,
  "localConnectedUsers": 5,
  "totalOnlineUsers": 23,
  "redis": { "connected": true }
}
```

## 🔧 Production Deployment

### Load Balancer Configuration
Enable **session affinity (sticky sessions)** or use **Redis adapter** for Socket.IO to handle connections across multiple instances.

### Docker Scaling
```bash
# Scale to 3 WebSocket Gateway instances
docker-compose up --scale websocket-gateway=3
```

### Health Checks
Configure health check endpoint: `http://websocket-gateway:3004/health`

## 🐛 Troubleshooting

### Redis Connection Issues
- Check Upstash Redis URL format
- Verify network connectivity to Upstash
- Check Redis connection logs in console

### Cross-Server Message Delivery
- Verify all instances subscribe to same channels
- Check Redis pub/sub logs
- Monitor `serverId` in health endpoint

### Authentication Issues  
- Ensure JWT_SECRET matches auth-service
- Check token format and expiration
- Verify CORS configuration matches frontend URL