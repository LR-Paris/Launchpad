# Launchpad frontend: Vite build, served as static files by a pinned `serve`.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine
RUN npm install -g serve@14.2.6 --no-audit --no-fund
USER node
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
EXPOSE 3000
CMD ["serve", "-s", "dist", "-l", "3000"]
