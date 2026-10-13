# syntax=docker/dockerfile:1.7
# Imagen de Guard-IA Plataforma (Next.js standalone), la consola del equipo Guard-IA. Desde la raíz:
#   docker build -f apps/platform/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.ejemplo.cl -t guardia-platform .
# NEXT_PUBLIC_API_URL queda fijada en el bundle: una imagen por entorno (igual que la central).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/platform/package.json apps/platform/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @guardia/platform...

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/platform apps/platform
RUN pnpm --filter @guardia/shared build && pnpm --filter @guardia/platform build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3002 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd -r -u 1001 guardia
COPY --from=build /app/apps/platform/.next/standalone ./
COPY --from=build /app/apps/platform/.next/static ./apps/platform/.next/static
COPY --from=build /app/apps/platform/public ./apps/platform/public
USER guardia
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3002/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/platform/server.js"]
