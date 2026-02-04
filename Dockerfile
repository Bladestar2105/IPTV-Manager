FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --prod --frozen-lockfile

# Copy application code
COPY src ./src
COPY public ./public
COPY .env.example ./.env.example

# Set environment variables
ENV DATA_DIR=/data
ENV PORT=3000
ENV NODE_ENV=production

# Create data directory
RUN mkdir -p /data

# Expose port
EXPOSE 3000

# Define volume for data persistence
VOLUME ["/data"]

# Start application
CMD ["pnpm", "start"]
