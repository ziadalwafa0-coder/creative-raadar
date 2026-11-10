FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-venv \
    && python3 -m venv /opt/media \
    && /opt/media/bin/pip install --no-cache-dir yt-dlp \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/media/bin:$PATH"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run lint && npm run build

ENV NODE_ENV=production
ENV DATA_DIR=/tmp/creative-radaar-v3
USER node
EXPOSE 3000
CMD ["npm", "start"]
