# syntax=docker/dockerfile:1.7
# Imagen de Guard-IA Core. Se construye desde la raíz del monorepo:
#   docker build -f apps/api/Dockerfile -t guardia-api .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @guardia/shared build && pnpm --filter @guardia/api build
# Copia instalable solo con dependencias de producción (incluye @guardia/shared ya compilado).
RUN pnpm --filter @guardia/api --prod deploy --legacy /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN useradd -r -u 1001 guardia
COPY --from=build /out /app
COPY --from=build /app/apps/api/dist /app/dist
USER guardia
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migraciones: node dist/cli/migrate.js · Seed: node dist/cli/seed.js
CMD ["node", "dist/main.js"]
