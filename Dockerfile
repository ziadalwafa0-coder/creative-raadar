FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY scraper/requirements.txt /tmp/scraper-requirements.txt
RUN python3 -m venv /opt/scrapling \
    && /opt/scrapling/bin/pip install --no-cache-dir -r /tmp/scraper-requirements.txt \
    && /opt/scrapling/bin/python -c "from scrapling.fetchers import Fetcher"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV DATA_DIR=/tmp/creative-radaar
ENV SCRAPLING_ENABLED=1
ENV SCRAPLING_PYTHON=/opt/scrapling/bin/python
USER node
EXPOSE 3000
CMD ["npm", "start"]
