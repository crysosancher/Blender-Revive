# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy configuration files
COPY package*.json tsconfig.json ./

# Install all dependencies (including typescript)
RUN npm ci

# Copy the source files
COPY src/ ./src/

# Build the project (compiles TypeScript to dist/)
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built files from the build stage
COPY --from=builder /app/dist ./dist

# Create volume target directories
RUN mkdir -p logs

# Set environment defaults
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# Start the bot
CMD ["npm", "start"]
