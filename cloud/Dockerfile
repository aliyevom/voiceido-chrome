# Multi-stage build keeps the runtime image small (~150 MB) and free of
# devDependencies (typescript, tsx, etc.).

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run as non-root for defense-in-depth; the node base image already ships
# a non-privileged "node" user.
USER node

# Cloud Run sets PORT=8080 via env. We bind there in src/config.ts.
EXPOSE 8080

CMD ["node", "dist/server.js"]
