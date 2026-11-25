FROM node:22-alpine
WORKDIR /app
# opencc-js: Simplified -> Traditional (HK) conversion for Cantonese output.
RUN npm install --no-save opencc-js@1.0.5
COPY server.js .
COPY config.json .
EXPOSE 3089
CMD ["node", "server.js"]
