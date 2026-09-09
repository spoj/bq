FROM docker.io/library/node:24.12.0-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates git bash coreutils ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.85.1 \
    && npm cache clean --force

WORKDIR /work

ENTRYPOINT []
