# syntax=docker/dockerfile:1

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies rather than rebuilding, so the runtime tree is exactly
# what was compiled against.
RUN npm prune --omit=dev

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE ./

# Never run as root. node:alpine ships an unprivileged `node` user.
USER node

# stdio is the default so `docker run -i` behaves like the npx invocation.
# Set KAIDN_MCP_TRANSPORT=http (and publish the port) for remote agents.
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "if(process.env.KAIDN_MCP_TRANSPORT!=='http')process.exit(0);\
fetch('http://127.0.0.1:'+(process.env.KAIDN_MCP_PORT||8765)+'/health')\
.then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
