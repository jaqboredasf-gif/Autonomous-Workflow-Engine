# ---------------------------------------------------------------------------
# Purchasing Control Center — production image.
#
# HOST-NEUTRAL ON PURPOSE. This builds an ordinary Linux container that listens
# on a port. It knows nothing about Supabase, Vercel, Railway, Render, AWS or
# Azure, and it must keep knowing nothing: which of those Lippolis uses — if
# any — is IT's decision, and the application should not have an opinion that
# has to be undone later.
#
# What it expects from whatever runs it:
#
#   a port to listen on              PORT, default 3000
#   a writable directory for data    the volume mounted at /data
#   its configuration in the env     see .env.example; nothing is baked in
#   TLS terminated in front of it    a reverse proxy, provided by infrastructure
#
# Three stages, because the runtime should contain the application and its
# dependencies and nothing that built them: no compiler, no toolchain, no
# source, no test suites, no repository.
# ---------------------------------------------------------------------------

# Node 24 because the pilot store uses `node:sqlite`, which is part of the
# runtime rather than a compiled dependency — no build tools, no native module
# to rebuild per architecture, nothing to go wrong on a machine that is not
# this one. bookworm-slim rather than alpine: glibc, so the prebuilt binaries
# Next pulls in (sharp) are the ones its authors test.
ARG NODE_VERSION=24-bookworm-slim

# --- 1. dependencies -------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo

# Only the manifests, so this layer is cached until a dependency actually
# changes. `npm ci` installs exactly the lockfile, which is what makes two
# builds of the same commit the same image.
COPY package.json package-lock.json ./
COPY apps/purchasing/package.json apps/purchasing/
COPY packages/workflow/package.json packages/workflow/
COPY packages/shared/package.json packages/shared/
COPY packages/mcp-server/package.json packages/mcp-server/
RUN npm ci --workspaces --include-workspace-root

# --- 2. build --------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /repo/node_modules ./node_modules
COPY . .

# NODE_ENV is deliberately NOT production here. `next build` needs the dev
# dependencies (typescript, tailwind) that a production install would omit, and
# the output it produces is the production output either way.
RUN npm run build --workspace purchasing

# The package must not contain a database, a journal, a key or an environment
# file — see the script's header for what happens when it does. .dockerignore
# should already have made this impossible; this is what proves it, per build,
# rather than per code review.
RUN node scripts/check-deployable.mjs

# --- 3. runtime ------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PCC_DATABASE_PATH=/data/pcc.sqlite

# The standalone output is the server plus the dependencies actually traced
# into it. `static` and `public` are copied separately because Next does not
# fold them in — a standalone build without them serves an unstyled page and
# no logo, which looks like a broken deployment and is a missing COPY.
COPY --from=build --chown=node:node /repo/apps/purchasing/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/purchasing/.next/static ./apps/purchasing/.next/static
COPY --from=build --chown=node:node /repo/apps/purchasing/public ./apps/purchasing/public

# The data directory belongs to the volume, not to the image. It is created
# here only so the container starts correctly when a host directory is bind
# mounted over it, and it is owned by the user the process runs as.
#
# NOTHING IS WRITTEN INTO IT AT BUILD TIME, and there is no seed step: a fresh
# database is created only on a start that says so (PCC_DATABASE_ALLOW_CREATE),
# which is what stops a redeploy against an unmounted volume from quietly
# standing up an empty purchasing system beside the real one.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Non-root. `node` exists in the base image with uid/gid 1000, which is also
# the default for a Linux login account, so a bind-mounted host directory
# usually needs no chown. When it does, the deployment handoff says so.
USER node

EXPOSE 3000

# The health endpoint answers whether configuration loaded and the database can
# be READ, not merely whether the process is up — an instance pointed at the
# wrong volume answers 503 here and a proxy can drain it. No curl in the image;
# Node is already there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Deterministic: one process, no shell, no wrapper, signals reaching the server
# so `docker stop` is a clean shutdown rather than a kill.
CMD ["node", "apps/purchasing/server.js"]
