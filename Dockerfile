FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev fonts-liberation imagemagick \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
# The sharp npm package ships platform-specific native binaries via optional
# dependencies. When `package-lock.json` is regenerated on macOS (arm64) it
# locks only the darwin binary; `npm ci` on linux-x64 then respects the
# lockfile and leaves Sharp unusable, causing the container to exit before
# it can listen on port 8080 with "Could not load the sharp module using the
# linux-x64 runtime". This step force-installs the linux-x64 Sharp binary
# regardless of what the lockfile remembers. See
# https://sharp.pixelplumbing.com/install#cross-platform
RUN npm install --os=linux --cpu=x64 --include=optional sharp
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
