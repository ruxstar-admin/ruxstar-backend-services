FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js lib/ routes/

RUN chown -R node:node /app

ENV NODE_ENV=production

USER node

EXPOSE 8080

CMD ["node", "index.js"]
