# ==============================================================================
# Multi-Stage Dockerfile for Apartment Checklist Application
# Optimized for small footprint, security (non-root), and reliable native builds
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build & Dependencies
# ------------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

# Copy package manifests
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev || npm install --omit=dev

# ------------------------------------------------------------------------------
# Stage 2: Production Runtime
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

# Create directory for SQLite persistent database and assign permissions to 'node' user
RUN mkdir -p /app/data && chown -R node:node /app

# Copy node_modules from builder stage
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy application files
COPY --chown=node:node package*.json ./
COPY --chown=node:node server.js database.js ./
COPY --chown=node:node public ./public

# Switch to unprivileged 'node' user for security
USER node

# Expose web server port
EXPOSE 3000

# Mount persistent SQLite data directory
VOLUME ["/app/data"]

# Native healthcheck using Node 22 built-in fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/forms').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the application
CMD ["node", "server.js"]
