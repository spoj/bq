# Wrappers

Wrappers run an agent with the integration needed to report its cost to `bq`.

## Pi

`pi` loads a small extension that charges the current task for the cost added during the Pi session. It leaves normal Pi arguments and output unchanged.

```bash
bq add --cwd ~/src/app -- /path/to/bq/examples/pi -p "Fix the failing tests"
```

The wrapper does nothing outside a task, when `BQ_TASK_ID` is unset.
