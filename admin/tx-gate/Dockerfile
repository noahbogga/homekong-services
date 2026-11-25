FROM node:22-alpine
# openssh-client for the SSH-based restarts/log-tailing to fxMain/VPS
RUN apk add --no-cache openssh-client
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
# users.json, jwt_secret, vm_secret, and the SSH key are bind-mounted at runtime
EXPOSE 3001
CMD ["node", "server.js"]
