# syntax=docker/dockerfile:1
# Google Workspace Open Admin, built from Next.js' standalone output.
#
#   docker build -t open-admin .
#   docker run -d --name open-admin -p 3000:3000 -v open-admin-data:/data \
#     -e APP_PASSWORD='something-long-and-random' open-admin
#
# State lives in /data (tenants, sign-on config, audit log, imported keys):
# mount a volume there. To serve the app under a real hostname, also set
# APP_ALLOWED_ORIGINS=https://admin.example.com - see docs/DEPLOY-CLOUDFLARE.md,
# which includes a Compose file with a Cloudflare Tunnel in front.

FROM node:22-alpine AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next/font/google fetches DM Sans and JetBrains Mono during the build and
# inlines them, so the build needs network access; the running container never
# does anything but talk to Google's APIs.
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # Listen on every interface inside the container. The app treats a loopback
    # browser Origin as local when bound this way, so plain port-mapping works;
    # a public hostname additionally needs APP_ALLOWED_ORIGINS.
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    OPEN_ADMIN_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:3000/login || exit 1
CMD ["node", "server.js"]
