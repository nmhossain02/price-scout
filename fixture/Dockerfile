FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=4173
WORKDIR /app
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4173
CMD ["node", "dist/server.js"]
