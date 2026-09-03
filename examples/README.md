# Wrappers

Wrappers enqueue agents and report their cost to `bq`.

## Pi

Put `bq-pi` on your `PATH`, for example:

```bash
ln -s /path/to/bq/examples/bq-pi ~/bin/bq-pi
```

Then enqueue Pi directly:

```bash
cd ~/src/app
bq-pi -p "Fix the failing tests"
```

`bq-pi` runs `bq add` with the current directory and its Pi arguments. When the worker starts it, it runs Pi and charges the task for usage added to its sessions. It includes `pi-tiny-fork` children by following their transcript paths and deduplicating history copied from parent sessions.

The wrapper loads `pi-session.ts` to identify its parent sessions. It does not scan unrelated sessions, so concurrent Pi runs are not charged. `--no-session` usage cannot be reported.
