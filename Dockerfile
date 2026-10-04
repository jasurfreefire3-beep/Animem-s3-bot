FROM node:22-alpine

WORKDIR /app

# Install FFmpeg for video HLS transmuxing
RUN apk add --no-cache ffmpeg

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy application files
COPY . .

# Create cache directory
RUN mkdir -p /app/cache

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
