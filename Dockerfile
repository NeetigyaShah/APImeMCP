FROM node:20-slim AS base
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium
COPY --from=build /app/dist ./dist
COPY templates ./templates
RUN groupadd -r mcp \
    && useradd -r -g mcp -m mcp \
    && chown -R mcp:mcp /app
USER mcp
ENTRYPOINT ["node", "dist/index.js"]
