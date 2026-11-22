FROM node:24-trixie-slim

COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /workspace

WORKDIR /workspace
USER node
CMD ["sleep", "infinity"]
