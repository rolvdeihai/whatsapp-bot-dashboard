FROM node:18-bullseye

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

# Create a non-root user
RUN groupadd -r appuser && useradd -r -g appuser -u 1001 appuser

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install Playwright Chromium
RUN npx playwright install chromium

# Change ownership to the non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

COPY . .

EXPOSE 7860
CMD ["node", "src/index.js"]