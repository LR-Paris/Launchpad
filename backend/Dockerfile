FROM node:20-alpine

# Install git (for shop template cloning) and docker CLI (for container management)
RUN apk add --no-cache git docker-cli docker-cli-compose

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

EXPOSE 3001

CMD ["node", "src/index.js"]
