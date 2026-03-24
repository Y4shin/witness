# ── Build stage ───────────────────────────────────────────────────────────────
# Installs all dependencies, generates the Prisma client, and builds the
# SvelteKit app with adapter-node.
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

# Generate the Prisma client into src/lib/server/prisma/ before the vite build
# so the bundler can include it.
COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Lean image: only production dependencies + compiled output.
FROM node:22-alpine AS runner
WORKDIR /app

# Install production deps.
# The `prisma` package (in dependencies) downloads its migration engine binary
# via its postinstall hook — required for `prisma migrate deploy` at startup.
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled SvelteKit server bundle
COPY --from=builder /app/build ./build

# Prisma schema + migrations (needed by `prisma migrate deploy`)
COPY --from=builder /app/prisma ./prisma

# Prisma config (Prisma 7 reads DATABASE_URL from here, not schema.prisma)
COPY prisma.config.ts ./

# OpenTelemetry bootstrap (loaded via --import before the server starts)
COPY instrumentation.js ./

# Create the uploads directory. Mount a named volume here when using the
# local-filesystem storage backend (default when S3_* vars are not set).
RUN mkdir -p uploads /data

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app /data
USER app

EXPOSE 3000

# On container start:
#   1. Apply any pending Prisma migrations against the configured DATABASE_URL.
#   2. Launch the SvelteKit Node server.
CMD ["sh", "-c", "npx prisma migrate deploy && node --import ./instrumentation.js ./build/index.js"]
