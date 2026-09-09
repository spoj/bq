#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
npm install --global --prefix "$HOME/.local" "$ROOT"
install -Dm644 "$ROOT/bq-worker.service" "$HOME/.config/systemd/user/bq-worker.service"
systemctl --user daemon-reload
systemctl --user enable --now bq-worker.service
