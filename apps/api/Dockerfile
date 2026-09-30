# syntax=docker/dockerfile:1
#
# The one Veyrafy image (docs/RUNBOOK-RAILWAY.md). The same image runs every service:
#   - a client instance (demo.veyrafy.com, toit.veyrafy.com): one Node.js process with the REST
#     API, the job runner, pdf.js, Tesseract OCR in WebAssembly, the fake ERP on SQLite, AND the
#     built web app on the same origin (VEYRA_WEB_DIST), so the browser calls /api/v1 on itself;
#   - the public website (veyrafy.com): VEYRA_SITE_ONLY=true, the built web app only.
#
#   docker build -f apps/api/Dockerfile -t veyra-api .          # from the repository root
#
# Configuration comes only from the environment at run time (.env.example); the image holds no
# secret and no data. VEYRA_DATA_DIR must be a PERSISTENT volume (uploaded documents and the fake
# ERP's SQLite file): mount one at /var/lib/veyra.

# The full image has python3, make and g++, for native modules without a prebuilt binary for the
# platform (better-sqlite3, @node-rs/argon2). The runtime image below is the slim one.
FROM node:22-bookworm AS build
WORKDIR /srv/veyra
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/erp-connector/package.json packages/erp-connector/
COPY packages/extractor/package.json packages/extractor/
COPY packages/fake-erp/package.json packages/fake-erp/
COPY packages/india-tax/package.json packages/india-tax/
COPY packages/shared/package.json packages/shared/
# Exactly the lockfile. The API runs its TypeScript through tsx (a root dev dependency), so dev
# dependencies are installed. A build behind a TLS-inspecting proxy can pass its CA bundle as the
# optional secret `npm_ca`; it is not kept in the image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN --mount=type=secret,id=npm_ca,required=false \
  if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
  npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/web apps/web
COPY fixtures fixtures
# The web app, built into apps/web/dist and served by the API (never `vite preview`). The build
# refuses any VITE_ variable but VITE_API_BASE_URL, which stays unset: same origin.
RUN npm run build -w @veyra/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
  VEYRA_API_HOST=0.0.0.0 \
  VEYRA_DATA_DIR=/var/lib/veyra \
  VEYRA_WEB_DIST=/srv/veyra/apps/web/dist
WORKDIR /srv/veyra
COPY --from=build --chown=root:root /srv/veyra /srv/veyra
# The application files belong to root and are read-only for the process; only the data volume
# is writable, by the unprivileged `node` user.
RUN mkdir -p /var/lib/veyra && chown node:node /var/lib/veyra
USER node
VOLUME ["/var/lib/veyra"]
EXPOSE 8787
# Liveness only (no dependency checked); platforms should probe /api/v1/health/ready for traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VEYRA_API_PORT||process.env.PORT||8787)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Exec form: Node is the process that receives SIGTERM, so the API finishes the current job and
# closes cleanly (DEPLOYMENT.md §7). No npm in between.
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
