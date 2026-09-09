# bq

`bq` queues Pi coding tasks and integrates their committed changes into a
harness-owned Git branch. Work runs in rootless Podman containers. Your source
checkout is never modified.

## The short version

Start the runner from any directory, even before there are tasks:

```sh
bq run --concurrency 1.5
```

Then, from a Git repository in another terminal:

```sh
bq add "Fix the login bug"
```

`run` stays in the foreground and processes the shared queue across projects,
waiting when it is empty. `add` queues and wakes the runner; it never starts
one. Queuing tasks before starting `run` works too.

```sh
bq                         # compact status
bq show 12                 # details, logs, or blocked reason
bq cancel 12
bq retry 12
bq config                  # current project settings
bq config --model anthropic/claude-sonnet-4-5 --check 'npm test'
bq config --concurrency 1.5
```

Use `--json` on status-producing commands for machine-readable output. The
normal output is intended for a terminal, not for scripts.

`bq add` uses the current repository and branch. The first add automatically
registers the project. The model is taken from bq's settings or Pi's configured
`defaultProvider`, `defaultModel`, and `defaultThinkingLevel`. If no model is
configured, an interactive add asks once; noninteractive use prints:

```text
No model configured. Run: bq config --global --model PROVIDER/MODEL
```

Set defaults for future projects with `--global`:

```sh
bq config --global --model anthropic/claude-sonnet-4-5
bq config --global --thinking medium --image bq-agent:local
```

Project configuration is remembered independently of the branch currently
checked out. `--cwd PATH` works with `add`, `config`, and `sync`.

## Concurrency

The target is average simultaneous container concurrency, not money. Fractions
are valid:

```sh
bq config --concurrency 0.2
bq run                    # optionally: bq run --concurrency 1.5
```

A target of `0` pauses new starts. Running containers are never preempted.
The instantaneous ceiling is `ceil(target)`. Idle credit is bounded to one
minute of target concurrency, and agents, checks, conflict resolution, and
repairs all consume the same allowance.

## Configuration

Useful project/default options:

```text
--model PROVIDER/MODEL
--thinking LEVEL          Pi thinking level, default medium
--check COMMAND           check proposed integrations; --check '' clears it
--image IMAGE             default bq-agent:local
--pi-config PATH          Pi config directory, default ~/.pi/agent
--max-repairs N           automatic repair attempts, default 3
--env NAME                explicitly pass a host variable; repeatable
--concurrency N           global scheduler target
```

Only variables named with `--env` are passed to a task. Host environment and
proxy variables are not implicitly passed. `--env ''` clears the configured
list. Pi `auth.json` and `models.json` are copied once into each task's private
state and sessions survive repair runs. Only model/thinking defaults are read
from Pi settings; host extensions and other settings are not imported.

## Podman setup

Requirements: Linux, Node.js 24.12+, Git, rootless Podman with subordinate
UID/GID ranges in `/etc/subuid` and `/etc/subgid`, GNU `cp`, and `flock`.
Btrfs is recommended for reflink-backed workspaces.

The runner builds the bundled image automatically when a task first needs it.
To use bq directly from this checkout without installing it:

```sh
npm run build
./dist/cli.js run
```

If rootless Podman was just configured:

```sh
bq podman system migrate
bq podman info
```

bq keeps its own Podman images and layers under
`${XDG_DATA_HOME:-~/.local/share}/bq/podman/`; runtime state is under
`${XDG_RUNTIME_DIR:-/run/user/$UID}/bq/`. Inspect that store with
`bq podman ps`, `bq podman images`, or any other Podman arguments. Tasks use
`--pull=never`; custom images must be built or pulled explicitly. Image builds
and task runs disable implicit proxy forwarding.

Install the local package and run continuously only if wanted:

```sh
npm install --global --prefix "$HOME/.local" .
./deploy-local.sh
```

Only invoking `deploy-local.sh` installs and starts the service. Neither
`add` nor `run` installs a service.

## Git integration and local files

For each project, bq stores an integration clone under
`${XDG_DATA_HOME:-~/.local/share}/bq/integrations/` and owns its
`bq-integration` branch. Each task gets a private reflink-backed workspace.
The canonical integration checkout is never left conflicted.

Tracked files start at `bq-integration`. All ignored and untracked files from
the original checkout are copied too, including `.env`, credentials,
dependencies, and caches. Copies are private; resumed tasks keep their existing
workspace. Uncommitted changes to tracked source files are not copied. Ignored
inputs cannot be committed by a task; ordinary untracked files may be
explicitly committed when required. Copying is not an atomic filesystem
snapshot. Host dependencies may need rebuilding in the image, and the agent
can read any secrets included in the workspace.

Agents work in parallel. bq validates each candidate merge, runs the optional
check command, and only then atomically advances `bq-integration`. A conflict
wakes Pi with a resolution request. Upstream is fetched when work starts or
when `bq sync [--cwd PATH]` is requested. A task is complete only after
integration, not merely when Pi exits.

Consume accepted work manually:

```sh
git fetch ~/.local/share/bq/integrations/project-... bq-integration
git merge FETCH_HEAD
```

The original repository's branch is never changed by bq.

## Advanced commands and state

```sh
bq sync [--cwd PATH]
bq build [--tag IMAGE]
bq podman ARGS...
bq help --all
```

State defaults to `${XDG_STATE_HOME:-~/.local/state}/bq/queue.sqlite`; data
and integration clones default to `${XDG_DATA_HOME:-~/.local/share}/bq/`.
Override them with `BQ_STATE_HOME` and `BQ_DATA_HOME`.

Development and the real local smoke test:

```sh
npm test
npm run build
npm run test:podman
```

The smoke test uses a local deterministic API and makes no paid model calls.
