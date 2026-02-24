FROM node:20-alpine

# Install git (for cloning shop templates), docker-cli (for managing shop containers),
# and build tools needed to compile native npm modules (bcrypt, better-sqlite3) on alpine.
RUN apk add --no-cache git docker-cli docker-cli-compose python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

# Remove build tools after install to keep image small
RUN apk del python3 make g++

COPY . .

EXPOSE 3001

CMD ["node", "src/index.js"]
