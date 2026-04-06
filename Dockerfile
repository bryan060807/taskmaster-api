FROM docker.io/library/node:20-alpine
WORKDIR /app/taskmaster-api
COPY taskmaster-api/package*.json ./
RUN npm install
COPY taskmaster-api/ ./
COPY libs/auth /app/libs/auth
EXPOSE 3001
CMD ["node", "server.js"]
