FROM node:20-alpine

# Install git (for cloning shop templates) and docker-cli (for managing shop containers)
RUN apk add --no-cache git docker-cli docker-compose

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

EXPOSE 3001

CMD ["node", "src/index.js"]
