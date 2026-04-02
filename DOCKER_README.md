# Konnect Docker Setup with Traefik API Gateway

Docker Compose configuration for Konnect microservices using Traefik as API Gateway.

## Services Included

- **traefik**: API Gateway with automatic service discovery
- **auth-service**: Authentication service 
- **email-service**: Email consumer service  

## Infrastructure

This setup uses your existing cloud services:
- **MongoDB**: MongoDB Atlas
- **Redis**: Upstash Redis  
- **RabbitMQ**: CloudAMQP

## Service URLs

### Public Access (through Traefik):
- **Traefik Dashboard**: http://localhost:8080
- **Auth Service**: http://localhost/auth
- **Email Service**: Background consumer service (no HTTP endpoints)

### Direct Access (internal Docker network):
- Services communicate internally using service names (auth-service, email-service)

## Quick Start

### 1. Build and Start All Services
```bash
docker-compose up --build
```

### 2. Start in Background
```bash
docker-compose up -d --build
```

### 3. View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f auth-service
docker-compose logs -f email-service
docker-compose logs -f traefik
```

### 4. Stop Services
```bash
docker-compose down
```

## Traefik Configuration

### Routing Rules:
- **PathPrefix**: `/auth` → auth-service (port 3002)
- **Email Service**: No routing (background message consumer)

### Labels Explained:
- `traefik.enable=true` - Enable Traefik for this service
- `traefik.http.routers.*.rule` - Define routing rules
- `traefik.http.services.*.loadbalancer.server.port` - Internal service port
- `traefik.http.middlewares.*.stripprefix.prefixes` - Remove path prefix before forwarding

### Service Discovery:
Traefik automatically discovers services using Docker provider:
- Monitors Docker socket for container changes
- Uses labels for routing configuration
- No manual configuration needed for new services

## Production Features:

- **Automatic Service Discovery**: Add new services with labels
- **Health Checks**: Built-in health monitoring
- **Load Balancing**: Automatic load balancing across service instances
- **SSL/TLS Ready**: HTTPS entry points configured (port 443)
- **Dashboard**: Web UI for monitoring and debugging

## Development Mode

For development with hot reloading:
```bash
docker-compose -f docker-compose.yaml -f docker-compose.override.yaml up
```

## Testing the Setup

### 1. Check Traefik Dashboard
Visit: http://localhost:8080

### 2. Test Auth Service
```bash
curl http://localhost/auth/health
```

### 3. View Service Discovery
Check the Traefik dashboard to see discovered services and routing rules.

## Troubleshooting

### Service Not Accessible
1. Check Traefik dashboard for discovered services
2. Verify service labels in docker-compose.yaml
3. Ensure service is healthy: `docker-compose ps`

### Traefik Not Starting
```bash
# Check Traefik logs
docker-compose logs traefik

# Verify Docker socket is accessible
docker-compose exec traefik ls -la /var/run/docker.sock
```

### Business Logic Unchanged
- Services communicate internally using service names
- No changes to application code required
- Environment variables remain the same