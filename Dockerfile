# Hosted demo image. The real product is the compiled executable in dist/ —
# this exists only so the app can be shown to someone without handing them a
# binary to run. See "Hosted demo" in the README.

FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
# devDependencies are types only; Bun strips types without needing them.
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src

# Baked in rather than copied by an entrypoint, so every container start —
# including a restart after someone edits things mid-demo — comes up on the
# same known-good caseload. The container filesystem is ephemeral; nothing
# entered against this deployment is meant to survive.
COPY --chown=bun:bun seed/demo-data.json ./data.json

# COPY --chown sets ownership on the copied files, not on the WORKDIR holding
# them — /app itself stays root-owned 755. Saving needs to *create* entries in
# that directory (backups/, and the data.json.tmp of the atomic write), which
# the bun user cannot do without owning it, so every write failed with EACCES.
RUN chown bun:bun /app

USER bun
EXPOSE 4321
CMD ["bun", "src/server.ts"]
