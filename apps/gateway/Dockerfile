FROM node:24-bookworm AS build

WORKDIR /app

RUN npm install --global pnpm@11.11.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/gateway/package.json apps/gateway/tsconfig.json ./apps/gateway/

RUN pnpm install --frozen-lockfile

COPY packages/contracts ./packages/contracts
COPY apps/gateway ./apps/gateway
COPY migrations ./migrations

RUN pnpm --filter @agent-control/contracts build \
  && pnpm --filter @agent-control/gateway build

FROM node:24-bookworm

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/apps/gateway/package.json ./apps/gateway/package.json
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/gateway/node_modules ./apps/gateway/node_modules

WORKDIR /app/apps/gateway

EXPOSE 7070
CMD ["node", "dist/src/index.js"]
