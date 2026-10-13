FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/patch-actual-api.js ./scripts/
RUN npm ci --omit=dev

COPY bot.js parser.js receipt.js telegram-rate-limit.js dates.js conversations.js submission-journal.js submissions.js diagnostics.js api-logging.js ./

# Mount /data persistently. Run only one bot process per token/cache/journal.
ENV ACTUAL_DATA_DIR=/data
ENV BOT_DATA_DIR=/data/bot-data
ENV TZ=Asia/Singapore

CMD ["sh", "-c", "if [ -n \"$GCP_KEY_BASE64\" ]; then umask 077; printf '%s' \"$GCP_KEY_BASE64\" | base64 -d > /app/gcp-key.json || exit 1; export GOOGLE_APPLICATION_CREDENTIALS=/app/gcp-key.json; fi; exec node bot.js"]
