# ============================================================
# MULTI-STAGE DOCKERFILE FOR PRODUCTION DEPLOYMENT
# ============================================================

# Stage 1: Build & Compilation
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and contracts
COPY tsconfig.json hardhat.config.ts ./
COPY src/ ./src/
COPY contracts/ ./contracts/
COPY public/ ./public/

# Compile TypeScript
RUN npm run build

# Stage 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000
ENV HOST=0.0.0.0
ENV TRADING_MODE=MOCK
ENV LIVE_TRADING_ARMED=false
ENV AUTO_TRADE_ENABLED=false

# Copy only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy compiled artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Run as non-root user for container security
USER node

EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:5000/api/health || exit 1

# Start production API server
CMD ["node", "dist/src/api/server.js"]
