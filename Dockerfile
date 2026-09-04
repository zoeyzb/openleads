FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY recover-mcp ./recover-mcp
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
