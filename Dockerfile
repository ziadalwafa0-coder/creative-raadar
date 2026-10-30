FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV DATA_DIR=/tmp/creative-radaar
USER node
EXPOSE 3000
CMD ["npm", "start"]
