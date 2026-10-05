FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci --omit=dev --workspace server

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/package-lock.json ./package-lock.json
COPY server ./server
WORKDIR /app/server
ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
EXPOSE 4000
CMD ["node", "src/index.js"]
