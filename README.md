# aq

A budget-aware queue for CLI commands. `aq` credits an account at a fixed hourly rate, records costs after they are known, and starts one queued command whenever the balance is positive.

```text
balance = initial balance + completed hours × hourly credit - charges
```

Running work is allowed to finish after the balance becomes negative. New work waits until future credits make it positive again.

## Install

```bash
uv tool install .
aq budget set 5
```

The database defaults to `~/.local/state/aq/aq.db`. Set `AQ_DB` to use another path.

## Use

```bash
aq add --cwd ~/src/app -- pi -p "Fix the failing tests"
aq add --cwd ~/src/app -- cc -p "Review the API"
aq list
aq show 1

aq worker
```

The worker runs one command at a time as a transient systemd user service. Inspect and control a running task with standard tools:

```bash
journalctl --user -u aq-task-1
systemctl --user stop aq-task-1
```

Record cost whenever it becomes available:

```bash
aq charge 1 1.37
aq budget
```

The child command receives `AQ_TASK_ID` and `AQ_DB`, so an external wrapper can report its own cost. Costs are decimal credits; they do not have to represent dollars.

Other operations:

```bash
aq cancel 1
aq retry 1
aq budget set 5 --initial 10
aq worker --once
aq worker --direct       # bypass systemd-run
```

`budget set` starts a new accounting epoch. The initial balance defaults to one hour of credit.

## Run continuously

Install the example user service:

```bash
mkdir -p ~/.config/systemd/user
cp aq-worker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now aq-worker
```

Environment variables needed by agents launched with `systemd-run` must be available to the systemd user manager or configured on the worker service. Agents using credentials stored in their home directory need no extra setup.

## Isolation

Isolation is deliberately not part of `aq`. Queue an isolation tool as the command:

```bash
aq add -- docker run --rm your-agent-image pi -p "Do the task"
aq add -- bwrap ... opencode run "Do the task"
```

Systemd can provide basic resource controls by adding properties to the worker implementation or wrapping a command with `systemd-run`. Containers, worktrees, remote execution, and agent-specific behavior remain outside the queue.

## Development

```bash
uv sync
uv run python -m unittest discover -s tests -v
```
