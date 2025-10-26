FROM node:20-bullseye

# Install minimal required dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libgbm1 \
    libasound2 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

# Create app user and its home directory
RUN groupadd -r appuser && useradd -r -g appuser -u 1001 appuser && \
    mkdir -p /home/appuser && chown -R appuser:appuser /home/appuser

WORKDIR /app

COPY package*.json ./
RUN npm install

# Switch to non-root user BEFORE installing Playwright
USER appuser

# Install Chromium under this user
RUN npx playwright install chromium

COPY . .

# 🆕 Create and set permissions for temp directories
USER root
RUN mkdir -p /tmp/whatsapp-bot && \
    chown -R appuser:appuser /tmp/whatsapp-bot && \
    chmod 755 /tmp/whatsapp-bot
USER appuser

EXPOSE 7860
CMD ["node", "src/index.js"]