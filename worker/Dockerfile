FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
    ARTIFACT_DIR=/data/artifacts
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 scout \
    && useradd --system --uid 10001 --gid scout --create-home scout \
    && mkdir -p /data/artifacts && chown -R scout:scout /data
WORKDIR /app
COPY --from=build --chown=scout:scout /app/package.json ./
COPY --from=build --chown=scout:scout /app/node_modules ./node_modules
COPY --from=build --chown=scout:scout /app/dist ./dist
USER 10001:10001
CMD ["node", "dist/index.js"]
