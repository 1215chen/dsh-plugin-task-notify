FROM node:22-alpine

WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=8787 \
    DATA_DIR=/data \
    MAX_QUEUE=200 \
    HEARTBEAT_MS=20000

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/v1/health >/dev/null || exit 1

CMD ["node", "server.mjs"]
