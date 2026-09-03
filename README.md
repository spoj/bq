# bq

A budget-aware queue for CLI commands. `bq` credits an account at a fixed hourly rate, records costs after they are known, and starts one queued command whenever the balance is positive.

```text
balance = initial balance + completed hours × hourly credit - charges
```

Running work is allowed to finish after the balance becomes negative. New work waits until future credits make it positive again.

## Install

```bash
uv tool install .
bq budget set 5
```

The database defaults to `~/.local/state/bq/bq.db`. Set `BQ_DB` to use another path.

## Use

```bash
bq add --cwd ~/src/app -- pi -p "Fix the failing tests"
bq add --cwd ~/src/app -- cc -p "Review the API"
bq list
bq show 1

bq worker
```

The worker runs one command at a time as a transient systemd user service. Inspect and control a running task with standard tools:

```bash
journalctl --user -u bq-task-1
systemctl --user stop bq-task-1
```

Record cost whenever it becomes available:

```bash
bq charge 1 1.37
bq budget
```

The child command receives `BQ_TASK_ID` and `BQ_DB`, so an external wrapper can report its own cost. Costs are decimal credits; they do not have to represent dollars.

Other operations:

```bash
bq cancel 1
bq retry 1
bq budget set 5 --initial 10
bq worker --once
bq worker --direct       # bypass systemd-run
```

`budget set` starts a new accounting epoch. The initial balance defaults to one hour of credit.

## Deploy on this machine

After committing and pushing:

```bash
./deploy-local.sh
```

This installs the pushed commit with `uv tool install`, copies and enables `bq-worker.service`, and restarts the worker. Follow it with:

```bash
journalctl --user -u bq-worker -f
```

Environment variables needed by agents launched with `systemd-run` must be available to the systemd user manager or configured on the worker service. Agents using credentials stored in their home directory need no extra setup.

## Isolation

Isolation is deliberately not part of `bq`. Queue an isolation tool as the command:

```bash
bq add -- docker run --rm your-agent-image pi -p "Do the task"
bq add -- bwrap ... opencode run "Do the task"
```

Systemd can provide basic resource controls by adding properties to the worker implementation or wrapping a command with `systemd-run`. Containers, worktrees, remote execution, and agent-specific behavior remain outside the queue.

## Development

```bash
uv sync
uv run python -m unittest discover -s tests -v
```
