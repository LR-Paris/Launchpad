# Launchpad backend.
#
# Code and dependencies are baked in at build time. Data, shops, logs and the
# generated nginx includes are mounted at run time (see ../docker-compose.yml).
#
# This container has no Docker access. Every docker action goes to the host's
# launchpad-runner service over a unix socket (bin/launchpad-runner.js), and
# the host checks each request before it runs anything.

FROM node:24-alpine AS deps
# Build tools only matter if a native module has no prebuilt binary.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
# git: shops are cloned from and updated against the Shuttle template repo.
RUN apk add --no-cache git
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY templates ./templates
COPY scripts ./scripts
COPY bin/launchpad-runner.js /usr/local/bin/launchpad-runner
RUN chmod 755 /usr/local/bin/launchpad-runner
EXPOSE 3001
CMD ["node", "src/index.js"]
