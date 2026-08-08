# syntax=docker/dockerfile:1

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    USER_DB_PATH=/data/users.sqlite \
    USER_SESSION_CLEANUP_INTERVAL_MS=600000 \
    GUEST_CREATION_LIMIT=0 \
    GUEST_CREATION_WINDOW_MS=600000 \
    LEADERBOARD_CACHE_TTL_MS=60000 \
    ADMIN_KEY="" \
    BOT_ROOM_ENABLED=true \
    BOT_ROOM_READY_TIMEOUT_SECONDS=30 \
    METRICS_TOKEN="" \
    METRICS_LOG_INTERVAL_MS=60000 \
    TRUST_PROXY=false \
    AUTH_SCRYPT_CONCURRENCY=2 \
    AUTH_SCRYPT_QUEUE_LIMIT=32 \
    LOBBY_BROADCAST_DEBOUNCE_MS=100 \
    MAINTENANCE_INTERVAL_MS=500 \
    STATIC_COMPRESSION_CACHE_BYTES=16777216

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node index.html server.mjs ./
COPY --chown=node:node server ./server
COPY --chown=node:node src ./src
COPY --chown=node:node vendor ./vendor
COPY --chown=node:node sound ./sound

RUN mkdir -p /data && chown node:node /data

VOLUME ["/data"]

USER node

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5173/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "server.mjs"]
