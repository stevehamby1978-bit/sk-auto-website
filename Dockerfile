FROM node:22-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

# Use the same centralized V2 launcher as package.json so container/Railway
# deployments cannot silently bypass the V2 bootstrap and start legacy-only V1.
CMD ["node", "garavex-start.js"]
