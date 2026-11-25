FROM node:20-slim

# Install Google Chrome (same binary our probes validated at 83% CF pass rate)
RUN apt-get update && apt-get install -y wget gnupg ca-certificates --no-install-recommends \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
     > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
# Tell Playwright not to download bundled Chromium — we use system Chrome above
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY . .

ENV NODE_ENV=production
EXPOSE 4201
CMD ["node", "src/server.js"]
