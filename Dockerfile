# Build stage
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Runtime stage
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
# Install only production dependencies
RUN npm install --omit=dev
# Ensure data directories exist
RUN mkdir -p server/data/games
COPY server/data/layouts.json ./server/data/layouts.json

EXPOSE 3003
ENV NODE_ENV=production
ENV PORT=3003

CMD ["node", "dist/index.cjs"]
