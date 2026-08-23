# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# ─── deps ───────────────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @tela/api... --filter @tela/shared...

# ─── build ──────────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN pnpm --filter @tela/shared build && pnpm --filter @tela/api build

# ─── runtime ────────────────────────────────────────────────────────────────
# Reinstala só produção: a imagem final não carrega typescript, vitest nem
# eslint. São ~200MB de diferença e superfície de ataque a menos.
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @tela/api... --filter @tela/shared...

COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api/dist apps/api/dist

USER node
WORKDIR /repo/apps/api
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3333)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
