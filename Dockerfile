# The arena. The reference agent shares its workspace and lockfile, so it rides
# along in the install; agents in production are run by their owners.
FROM node:24-alpine AS base
WORKDIR /app
# pnpm is pinned by `packageManager` in package.json, and `corepack install`
# reads it from there, so the version lives in one place. Installed in the base
# image so the runtime stage boots from what it already holds: a container that
# starts from its own files boots on the day the registry is slow.
COPY package.json ./
RUN corepack enable && corepack install

# Dependencies first, so a code change reuses the resolved workspace.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile

FROM base AS build
# The whole resolved tree in one COPY. pnpm creates a package's node_modules
# when it has dependencies, so copying the tree whole keeps the build working
# for a package with zero.
COPY --from=deps /app ./
COPY . .
# next build needs the environment its config reads, and the secrets arrive at
# runtime.
ENV NEXT_TELEMETRY_DISABLED=1
# Next evaluates every route module to collect page data, and the database
# client needs a connection string to load. The build connects to nothing: the
# pool is lazy and the first query comes at runtime, so a placeholder is enough.
# It stays in this stage; the runtime stage is a separate FROM that copies
# files.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5/build
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./

# The image carries the full dependency tree. Next's standalone output emits its
# own minimal server and leaves a custom server's files behind, and the custom
# server is the whole reason this image exists: agents dial in over a WebSocket,
# which the custom server accepts.
EXPOSE 3000
CMD ["pnpm", "start"]
