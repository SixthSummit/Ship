# syntax=docker/dockerfile:1.7
#
# Multi-stage build for ShipAngular SSR on Cloud Run (or any Node host).
#
# - Stage 1 ("deps"): install all deps to a clean layer.
# - Stage 2 ("build"): build the SSR bundle.
# - Stage 3 (final): copy only the SSR runtime + browser assets onto a
#   distroless Node image. Smallest possible attack surface for prod.
#
# Build:   docker build -t {{PROJECT_NAME}} .
# Run:     docker run --rm -p 8080:8080 -e PORT=8080 {{PROJECT_NAME}}
# Deploy:  gcloud run deploy {{PROJECT_NAME}} --source .

ARG NODE_VERSION=22

# ---------- deps ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV CI=true \
    NODE_ENV=production \
    NG_BUILD_OPTIMIZATION=true
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm build:ssr

# ---------- runtime ----------
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Cloud Run expects the container to listen on $PORT (default 8080).
EXPOSE 8080
USER nonroot:nonroot

# `serve:ssr` is wired to dist/<project>/server/server.mjs by the template's
# package.json. The CLI rewrites {{PROJECT_NAME}} at scaffold time.
CMD ["dist/{{PROJECT_NAME}}/server/server.mjs"]
