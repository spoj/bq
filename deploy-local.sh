#!/usr/bin/env bash
set -eu

sha=$(git rev-parse HEAD)
uv tool install --force "git+https://github.com/spoj/bq.git@$sha"
install -Dm644 bq-worker.service "$HOME/.config/systemd/user/bq-worker.service"
systemctl --user daemon-reload
systemctl --user enable bq-worker.service
systemctl --user restart bq-worker.service
systemctl --user --no-pager status bq-worker.service
