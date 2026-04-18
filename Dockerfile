FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --omit=dev

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

# Drop root privileges for runtime
RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app /data
USER app

# Expose port
EXPOSE 3000

# Define volume for data persistence
VOLUME ["/data"]

# Start application
CMD ["npm", "start"]
