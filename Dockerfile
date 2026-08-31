# Stage 1: Build
FROM node:26-bookworm-slim AS build

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip g++ build-essential && \
    rm -rf /var/lib/apt/lists/*

RUN pip3 install mkdocs-techdocs-core --break-system-packages

RUN npm install -g corepack && corepack enable && \
    mkdir -p /home/node/.cache/node/corepack && \
    chown -R node:node /home/node/.cache

USER node
WORKDIR /app

COPY --chown=node:node .yarn ./.yarn
COPY --chown=node:node .yarnrc.yml package.json yarn.lock backstage.json ./

COPY --chown=node:node packages/backend/package.json packages/backend/
COPY --chown=node:node packages/app/package.json packages/app/
COPY --chown=node:node plugins/permission-backend-module-team-policy/package.json plugins/permission-backend-module-team-policy/
COPY --chown=node:node plugins/github-app-connect-backend/package.json plugins/github-app-connect-backend/
COPY --chown=node:node plugins/vault-secrets-backend/package.json plugins/vault-secrets-backend/
COPY --chown=node:node plugins/argo-workflows-backend/package.json plugins/argo-workflows-backend/
COPY --chown=node:node plugins/resource-usage-backend/package.json plugins/resource-usage-backend/
COPY --chown=node:node plugins/tenant-backend/package.json plugins/tenant-backend/
COPY --chown=node:node plugins/oidc-provider-backend/package.json plugins/oidc-provider-backend/
COPY --chown=node:node plugins/custom-domains-backend/package.json plugins/custom-domains-backend/
COPY --chown=node:node plugins/proposals-backend/package.json plugins/proposals-backend/

RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn install --immutable

COPY --chown=node:node . .

RUN yarn tsc && yarn build:backend --config ../../app-config.yaml --config ../../app-config.production.yaml

# Stage 2: Production
FROM node:26-bookworm-slim

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip g++ build-essential && \
    rm -rf /var/lib/apt/lists/*

RUN pip3 install mkdocs-techdocs-core --break-system-packages

RUN npm install -g corepack && corepack enable && \
    mkdir -p /home/node/.cache/node/corepack && \
    chown -R node:node /home/node/.cache

USER node
WORKDIR /app

COPY --chown=node:node --from=build /app/.yarn ./.yarn
COPY --chown=node:node --from=build /app/.yarnrc.yml ./
COPY --chown=node:node --from=build /app/backstage.json ./

ENV NODE_ENV=production
ENV NODE_OPTIONS="--no-node-snapshot"

COPY --chown=node:node --from=build /app/yarn.lock /app/package.json ./
COPY --chown=node:node --from=build /app/packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn workspaces focus --all --production

COPY --chown=node:node --from=build /app/packages/backend/dist/bundle.tar.gz ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

COPY --chown=node:node app-config*.yaml ./

EXPOSE 7007

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
