FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
# Optional additional trusted CA for builds behind a development proxy.
# The certificate is mounted for this step only and is never stored in the image.
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node server.cjs ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node LICENSE ./

USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', { signal: AbortSignal.timeout(2000) }).then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.cjs"]
