# Wrappers

Wrappers run an agent with the integration needed to report its cost to `bq`.

## Pi

`pi` runs Pi normally, then charges the current task for usage added to its sessions. It includes `pi-tiny-fork` children by following their transcript paths and deduplicating history copied from parent sessions.

```bash
bq add --cwd ~/src/app -- /path/to/bq/examples/pi -p "Fix the failing tests"
```

The wrapper loads `pi-session.ts` to identify its parent sessions. It does not scan unrelated sessions, so concurrent Pi runs are not charged. `--no-session` usage cannot be reported.

Outside a task, when `BQ_TASK_ID` is unset, the wrapper runs Pi without accounting.
