# Use Node.js 18 LTS Alpine for smaller image size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY . .

# Change ownership to nodejs user
RUN chown -R nodejs:nodejs /app
USER nodejs

# No port to expose as this is a message consumer service

# Add health check for the consumer process
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD pgrep -f "node.*server\.js" > /dev/null || exit 1

# Start the application
CMD ["npm", "start"]