# syntax=docker/dockerfile:1.7
# Imagen de Guard-IA Command (Next.js standalone). Se construye desde la raíz del monorepo:
#   docker build -f apps/command/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.ejemplo.cl -t guardia-command .
# NEXT_PUBLIC_API_URL queda fijada en el bundle: una imagen por entorno.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/command/package.json apps/command/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @guardia/command...

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/command apps/command
RUN pnpm --filter @guardia/shared build && pnpm --filter @guardia/command build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd -r -u 1001 guardia
# El standalone incluye su propio node_modules mínimo y server.js; static y public van aparte.
COPY --from=build /app/apps/command/.next/standalone ./
COPY --from=build /app/apps/command/.next/static ./apps/command/.next/static
COPY --from=build /app/apps/command/public ./apps/command/public
USER guardia
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/command/server.js"]
