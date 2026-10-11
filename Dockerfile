# The public intake (src/intake-server.ts). It holds only the intake's grant on the payout agent;
# secrets come from the host's environment, never from this image.
FROM node:24-slim

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src

# The money lock, the ops log (.ops/) and the intake's ledger (.intake/) are written to the working
# directory: mount a volume at /data so they survive redeploys. Losing them would forget which
# requests were filed, so a resubmitted invoice could be filed twice.
WORKDIR /data
ENV NODE_ENV=production INTAKE_HOST=0.0.0.0 INTAKE_TRUST_PROXY=true
EXPOSE 8080
CMD ["/app/node_modules/.bin/tsx", "/app/src/intake-server.ts"]
