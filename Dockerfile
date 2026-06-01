FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY bot.js parser.js receipt.js ./

CMD echo "$GCP_KEY_BASE64" | base64 -d > /app/gcp-key.json && \
    export GOOGLE_APPLICATION_CREDENTIALS=/app/gcp-key.json && \
    node bot.js
