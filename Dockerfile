FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev fonts-liberation imagemagick \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
