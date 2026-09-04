FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
RUN git clone --depth 1 https://github.com/zoeyzb/email-enrich.git /tmp/email-enrich \
    && cd /tmp/email-enrich \
    && npm install \
    && npm run build \
    && npm pack \
    && npm install /tmp/email-enrich/email-enrich-0.1.0.tgz \
    && rm -rf /tmp/email-enrich
COPY recover-mcp ./recover-mcp
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
