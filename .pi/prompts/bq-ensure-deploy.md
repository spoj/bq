---
description: Commit, push, and deploy bq on this machine
argument-hint: "[release instructions]"
---
Finish the current bq change and deploy it on this machine.

1. Run the relevant tests and inspect the diff.
2. Commit all intended changes and push the current branch.
3. If requested here, perform the release/publishing step: ${ARGUMENTS:-no separate release}.
4. Install the exact pushed commit with `uv tool install --force`.
5. Install `bq-worker.service` in `~/.config/systemd/user/`, reload systemd, enable it, and restart `bq-worker.service`.
6. Verify the installed `bq`, worker status, and clean Git state.

Use `bq`, never the old `aq` name. Report the commit, publication if any, installed version, and service status.
