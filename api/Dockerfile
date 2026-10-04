# syntax=docker/dockerfile:1
# api: Express gateway. Build from api/:
#   docker build -t equity-lens-api .
# Cloud Run injects PORT; locally it defaults to 3001.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

FROM ${NODE_IMAGE} AS base
# Prisma's query engine needs OpenSSL to detect and load the right binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Build with dev dependencies (TypeScript, Prisma CLI for `prisma generate`).
FROM base AS build
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
    # Keep production dependencies plus the generated client (.prisma/client).
    && npm prune --omit=dev --no-audit --no-fund \
    # npm keeps @prisma/client's peers (the Prisma CLI and TypeScript); the
    # generated client doesn't need them at runtime. Dropping the CLI, its
    # engines and config loader, and TypeScript saves ~165 MB.
    && rm -rf node_modules/prisma node_modules/@prisma/engines \
        node_modules/@prisma/config node_modules/effect node_modules/typescript \
        node_modules/.bin/prisma node_modules/.bin/tsc node_modules/.bin/tsserver

# Database migrations (Cloud Run job or one-off run):
#   docker build --target migrate -t equity-lens-api-migrate .
FROM base AS migrate
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
