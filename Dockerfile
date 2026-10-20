# Policy-desk CRM: one image with the API, the background worker and the built React app.
# Host-neutral: runs on any Docker host (Render, Railway, Fly.io, DigitalOcean, a VPS, AWS, …).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
# Firebase web config is baked into the browser bundle at build time (all optional).
ARG VITE_FIREBASE_API_KEY= VITE_FIREBASE_AUTH_DOMAIN= VITE_FIREBASE_PROJECT_ID= VITE_FIREBASE_MESSAGING_SENDER_ID= VITE_FIREBASE_APP_ID= VITE_FIREBASE_VAPID_KEY=
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# pg_dump for the daily backup job
RUN apk add --no-cache postgresql16-client tini
WORKDIR /app
ENV NODE_ENV=production PORT=4000 CLIENT_DIST=/app/client/dist STORAGE_LOCAL_DIR=/data/uploads
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/drizzle ./server/drizzle
COPY --from=build /app/client/dist ./client/dist
RUN mkdir -p /data/uploads /data/backups && chown -R node:node /data
USER node
WORKDIR /app/server
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Applies pending database migrations, then starts the API (+ worker unless RUN_WORKER=false).
CMD ["node", "dist/start.js"]
