# syntax=docker/dockerfile:1.4
# Builds the classic polis clients and serves their static assets to the
# polis-api reverse-proxy (STATIC_FILES_HOST=file-server).
# Build context MUST be the repo root:
#   docker compose --profile clients build file-server
#
# MEMORY SAFETY: BuildKit would parallelize the three independent client
# stages. Host RAM is tight (~350-700MB free) and 3 concurrent webpack
# builds can OOM Docker. Each stage therefore COPYs a marker from the
# previous stage to force strict sequential builds.

######################## POLIS CLIENT ADMIN ########################
FROM docker.io/node:24-alpine AS client-admin
WORKDIR /app
COPY client-admin/package*.json ./
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN --mount=type=cache,target=/root/.npm npm ci --production=false
COPY client-admin/. .
ARG ADMIN_UIDS
ARG AUTH_AUDIENCE
ARG AUTH_CLIENT_ID
ARG AUTH_ISSUER
ARG AUTH_NAMESPACE
ENV ADMIN_UIDS=${ADMIN_UIDS}
ENV AUTH_AUDIENCE=${AUTH_AUDIENCE}
ENV AUTH_CLIENT_ID=${AUTH_CLIENT_ID}
ENV AUTH_ISSUER=${AUTH_ISSUER}
ENV AUTH_NAMESPACE=${AUTH_NAMESPACE}
RUN npm run build:prod

######################## POLIS CLIENT PARTICIPATION ########################
FROM docker.io/node:24-alpine AS client-participation
# Serialization marker: wait for the admin build to finish (memory safety).
COPY --from=client-admin /app/build/ /tmp/admin-build-marker/
WORKDIR /app
COPY client-participation/package*.json ./
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN --mount=type=cache,target=/root/.npm npm ci --production=false
COPY client-participation/. .
ARG EMBED_SERVICE_HOSTNAME
ARG GA_TRACKING_ID
ARG OIDC_CACHE_KEY_PREFIX
ARG OIDC_CACHE_KEY_ID_TOKEN_SUFFIX
ENV EMBED_SERVICE_HOSTNAME=${EMBED_SERVICE_HOSTNAME}
ENV GA_TRACKING_ID=${GA_TRACKING_ID}
ENV OIDC_CACHE_KEY_PREFIX=${OIDC_CACHE_KEY_PREFIX}
ENV OIDC_CACHE_KEY_ID_TOKEN_SUFFIX=${OIDC_CACHE_KEY_ID_TOKEN_SUFFIX}
RUN npm run build:prod

######################## POLIS CLIENT REPORT ########################
FROM docker.io/node:24-alpine AS client-report
# Serialization marker: wait for the participation build to finish.
COPY --from=client-participation /app/dist/ /tmp/participation-dist-marker/
WORKDIR /app
RUN apk add git
COPY client-report/package*.json ./
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
RUN --mount=type=cache,target=/root/.npm npm ci --production=false
COPY client-report/. .
ARG GIT_HASH
ENV GIT_HASH=${GIT_HASH:-placeholder}
ARG AUTH_AUDIENCE
ARG AUTH_NAMESPACE
ARG AUTH_CLIENT_ID
ARG AUTH_ISSUER
ARG DD_APPLICATION_ID
ARG DD_CLIENT_TOKEN
ARG DD_SITE
ARG SERVICE_URL
ENV AUTH_AUDIENCE=${AUTH_AUDIENCE}
ENV AUTH_NAMESPACE=${AUTH_NAMESPACE}
ENV AUTH_CLIENT_ID=${AUTH_CLIENT_ID}
ENV AUTH_ISSUER=${AUTH_ISSUER}
ENV DD_APPLICATION_ID=${DD_APPLICATION_ID}
ENV DD_CLIENT_TOKEN=${DD_CLIENT_TOKEN}
ENV DD_SITE=${DD_SITE}
ENV SERVICE_URL=${SERVICE_URL}
RUN npm run build:prod

############################ FILE SERVER ############################
FROM docker.io/node:24-alpine
WORKDIR /app
COPY file-server/package*.json ./
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000
# npm install (not ci): the fork has no committed lockfile for file-server.
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev
COPY file-server/. .
# Merge the three client builds into one static root (upstream layout).
RUN mkdir -p /app/build
COPY --from=client-admin          /app/build/ /app/build
COPY --from=client-participation  /app/dist/  /app/build
COPY --from=client-report         /app/dist/  /app/build
EXPOSE 8080
CMD ["npm", "run", "serve"]
