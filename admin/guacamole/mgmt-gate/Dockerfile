FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js login.html dashboard.html guacamole.min.js novnc-keyboard.js ./
EXPOSE 3001 8443
CMD ["node", "server.js"]
