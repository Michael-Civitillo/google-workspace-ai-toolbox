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

FROM node:22.23.5-alpine AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22.23.5-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next/font/google fetches DM Sans and JetBrains Mono during the build and
# inlines them, so the build needs network access; the running container never
# does anything but talk to Google's APIs.
RUN npm run build
# What the runtime stage copies from here stays owned by root, and the server
# runs as "node": make sure that user can read it. The build's own output
# already is, but public/ and the health check come from the checkout with
# whatever modes it has, and a strict umask (027, 077) leaves them closed to
# everyone but their owner.
RUN chmod -R a+rX .next/standalone .next/static public deploy/docker

FROM node:22.23.5-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # Listen on every interface inside the container. The app treats a loopback
    # browser Origin as local when bound this way, so plain port-mapping works;
    # a public hostname additionally needs APP_ALLOWED_ORIGINS.
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    OPEN_ADMIN_DATA_DIR=/data \
    # Cap V8's heap. Without a limit Node sizes its heap from the host's total
    # memory and lets it grow long after a request is done, which on a 1-2 GB
    # box reads as a slow leak. 768 MB sits well above the working set (~100 MB
    # idle; a few hundred at the mailbox export/import caps) and low enough
    # that a genuine leak trips a fast OOM instead of swapping the host. The
    # small semi-space keeps scavenge copying - and so RSS - down for the
    # short-lived objects a request cycle produces.
    NODE_OPTIONS="--max-old-space-size=768 --max-semi-space-size=8"
# The application is owned by root and only readable by the user it runs as,
# so nothing the server does can rewrite its own code. /data, where every
# piece of state lives, is the only place it can write.
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/deploy/docker/healthcheck.mjs /usr/local/lib/open-admin/healthcheck.mjs
USER node
VOLUME ["/data"]
EXPOSE 3000
# Healthy means: answering on $PORT, APP_PASSWORD set (without it every API
# call is refused), and /data writable by this user. See healthcheck.mjs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/usr/local/lib/open-admin/healthcheck.mjs"]
CMD ["node", "server.js"]
