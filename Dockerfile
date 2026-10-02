FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
ARG EMAIL_ENRICH_REF=ab129e4ffbcb31d05f8b720fb7a0330411256696
RUN git init /tmp/email-enrich \
    && cd /tmp/email-enrich \
    && git remote add origin https://github.com/zoeyzb/email-enrich.git \
    && git fetch --depth 1 origin ${EMAIL_ENRICH_REF} \
    && git checkout --detach FETCH_HEAD \
    && npm install \
    && npm run build \
    && npm pack \
    && cd /app \
    && npm install /tmp/email-enrich/email-enrich-0.1.0.tgz \
    && rm -rf /tmp/email-enrich
COPY recover-mcp ./recover-mcp
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
